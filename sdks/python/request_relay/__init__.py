"""Software-only onboarding and request client. Never expose lifecycle methods as model tools."""
import base64
import hashlib
import json
import secrets
import struct
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.concatkdf import ConcatKDFHash


def _json(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def _b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _secret(prefix):
    return prefix + "_" + secrets.token_urlsafe(32)


def _hash(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def delivery_key():
    key = ec.generate_private_key(ec.SECP256R1()).private_numbers()
    public = {"kty": "EC", "crv": "P-256", "x": _b64(key.public_numbers.x.to_bytes(32, "big")), "y": _b64(key.public_numbers.y.to_bytes(32, "big"))}
    return {"id": _hash(_json(public)), "publicKey": public, "privateKey": {**public, "d": _b64(key.private_value.to_bytes(32, "big"))}}


def decrypt_delivery(delivery, service_id, key):
    protected, encrypted, iv, ciphertext, tag = delivery["envelope"].split(".")
    header = json.loads(_decode(protected))
    if encrypted or header.get("alg") != "ECDH-ES" or header.get("enc") != "A256GCM" or header.get("kid") != key["id"] or header.get("crit") or header.get("zip"):
        raise ValueError("Unsupported credential envelope")
    epk = header["epk"]
    if epk.get("kty") != "EC" or epk.get("crv") != "P-256" or "d" in epk:
        raise ValueError("Unsupported delivery key")
    private = ec.derive_private_key(int.from_bytes(_decode(key["privateKey"]["d"]), "big"), ec.SECP256R1())
    ephemeral = ec.EllipticCurvePublicNumbers(int.from_bytes(_decode(epk["x"]), "big"), int.from_bytes(_decode(epk["y"]), "big"), ec.SECP256R1()).public_key()
    apu, apv = _decode(header.get("apu", "")), _decode(header.get("apv", ""))
    other_info = struct.pack(">I", 7) + b"A256GCM" + struct.pack(">I", len(apu)) + apu + struct.pack(">I", len(apv)) + apv + struct.pack(">I", 256)
    cek = ConcatKDFHash(algorithm=hashes.SHA256(), length=32, otherinfo=other_info).derive(private.exchange(ec.ECDH(), ephemeral))
    payload = json.loads(AESGCM(cek).decrypt(_decode(iv), _decode(ciphertext) + _decode(tag), protected.encode()))
    for value in (header, payload):
        if value.get("serviceId") != service_id or value.get("connectionId") != delivery["connectionId"] or value.get("deliveryId") != delivery["deliveryId"]:
            raise ValueError("Delivery identifiers do not match")
    if payload.get("version") != 1 or not isinstance(payload.get("token"), str) or not payload["token"].startswith("smsr_") or len(payload["token"]) != 48:
        raise ValueError("Invalid connection credential")
    return payload


class RelayError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RelayClient:
    def __init__(self, base_url, allow_http_loopback=False, sleep=time.sleep):
        url = urlsplit(base_url)
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or (url.scheme != "https" and not (allow_http_loopback and url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1"))):
            raise ValueError("Use the configured HTTPS relay origin")
        self.base_url, self.sleep, self.opener = base_url.rstrip("/"), sleep, build_opener(_NoRedirect())

    def request(self, path, token, body=None, method=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Invalid relay route")
        for attempt in range(6):
            request = Request(self.base_url + path, data=None if body is None else _json(body), method=method or ("GET" if body is None else "POST"), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            try:
                with self.opener.open(request, timeout=20) as response:
                    return json.load(response)
            except HTTPError as error:
                status, retry = error.code, error.headers.get("Retry-After", "0")
                try:
                    code = json.load(error).get("error", "relay_error")
                except (ValueError, AttributeError):
                    code = "relay_error"
                finally:
                    error.close()
                if attempt == 5 or (status != 429 and status < 500):
                    raise RelayError(status, code) from None
                self.sleep(min(300, max(2 ** attempt, int(retry) if retry.isdigit() else 0)))
            except (URLError, TimeoutError):
                if attempt == 5:
                    raise RelayError(503, "relay_unavailable") from None
                self.sleep(min(30, 2 ** attempt))

    def poll(self, read):
        while True:
            result = read()
            if result["status"] == "approved":
                return result
            if result["status"] in ("expired", "denied", "revoked"):
                raise RelayError(410, "session_" + result["status"])
            self.sleep(max(1, result.get("interval", 5)))


class ServiceSession:
    def __init__(self, state, storage, **options):
        self.state, self.storage = state, storage
        self.client = RelayClient(state["baseUrl"], **options)

    @classmethod
    def create(cls, base_url, name, purpose, storage, capabilities=None, **options):
        client = RelayClient(base_url, **options)
        state = {"version": 1, "baseUrl": client.base_url, "name": name, "purpose": purpose, "capabilities": ["forms"] if capabilities is None else capabilities, "serviceToken": _secret("smss"), "registrationToken": _secret("smsreg"), "keys": [delivery_key()], "connections": {}}
        storage.save(state)
        return cls(state, storage, **options)

    @classmethod
    def resume(cls, storage, **options):
        state = storage.load()
        if not state:
            raise ValueError("No saved service session")
        return cls(state, storage, **options)

    def save(self):
        self.storage.save(self.state)

    def start_registration(self):
        s = self.state
        s["registration"] = self.client.request("/v3/registration-sessions", s["registrationToken"], {"name": s["name"], "purpose": s["purpose"], "capabilities": s["capabilities"], "credentialHash": _hash(s["serviceToken"]), "deliveryPublicKey": s["keys"][0]["publicKey"]})
        self.save()
        return {**s["registration"], "link": s["baseUrl"] + s["registration"]["registrationPath"]}

    def wait_for_registration(self):
        s = self.state
        if not s.get("registered"):
            self.start_registration()
            result = self.client.poll(lambda: self.client.request("/v3/registration-sessions/current", s["registrationToken"]))
            s.update(serviceId=result["serviceId"], servicePath=result["servicePath"], registered=True)
            self.save()
        self.consume_deliveries()
        return {"serviceId": s["serviceId"], "link": self.permanent_link()}

    def permanent_link(self):
        return self.state["baseUrl"] + self.state["servicePath"]

    def start_pairing(self, capabilities=None, expires_in_days=None, external_account_ref=None):
        s = self.state
        if not s.get("pairingInput"):
            s["pairingInput"] = {"capabilities": s["capabilities"] if capabilities is None else capabilities, "expiresInDays": expires_in_days, "idempotencyKey": str(uuid.uuid4())}
            if external_account_ref:
                s["pairingInput"]["externalAccountRef"] = external_account_ref
            self.save()
        s["pairing"] = self.client.request("/v3/service/pairing-sessions", s["serviceToken"], s["pairingInput"])
        self.save()
        return {**s["pairing"], "link": s["baseUrl"] + s["pairing"]["connectionPath"]}

    def wait_for_pairing(self):
        s = self.state
        if not s.get("pairing"):
            self.start_pairing()
        result = self.client.poll(lambda: self.client.request("/v3/service/pairing-sessions/" + s["pairing"]["sessionId"], s["serviceToken"]))
        self.consume_deliveries()
        s.update(pairing=None, pairingInput=None)
        self.save()
        return result["connectionId"]

    def restart_pairing(self, **options):
        self.state.update(pairing=None, pairingInput=None)
        self.save()
        return self.start_pairing(**options)

    def consume_deliveries(self):
        s = self.state
        count = 0
        for _ in range(10):
            page = self.client.request("/v3/service/deliveries", s["serviceToken"])
            for delivery in page["deliveries"]:
                key = next((k for k in s["keys"] + ([s["nextKey"]] if s.get("nextKey") else []) if k["id"] == delivery["keyId"]), None)
                if not key:
                    raise ValueError("Restore the retained delivery key before retrying")
                payload = decrypt_delivery(delivery, s["serviceId"], key)
                old = s["connections"].get(delivery["connectionId"])
                if old and old["token"] != payload["token"]:
                    raise ValueError("Delivery conflicts with the stored credential")
                s["connections"][delivery["connectionId"]] = {"token": payload["token"], "externalAccountRef": payload.get("externalAccountRef"), "deliveryId": delivery["deliveryId"]}
                self.save()
                self.client.request("/v3/service/deliveries/" + delivery["deliveryId"] + "/acknowledgement", s["serviceToken"], {})
            count += len(page["deliveries"])
            if not page.get("hasMore"):
                break
        return count

    def rotate_credential(self):
        s = self.state
        s.setdefault("nextServiceToken", _secret("smss"))
        self.save()
        try:
            self.client.request("/v3/service", s["serviceToken"], {"credentialHash": _hash(s["nextServiceToken"])}, "PATCH")
        except RelayError as error:
            if error.status != 401:
                raise
            self.client.request("/v3/service/deliveries", s["nextServiceToken"])
        s["serviceToken"] = s.pop("nextServiceToken")
        self.save()

    def rotate_key(self, retire_key_id=None):
        s = self.state
        if not s.get("nextKey"):
            s["nextKey"] = delivery_key()
            s["nextRetireKeyId"] = retire_key_id
        elif "nextRetireKeyId" not in s:
            s["nextRetireKeyId"] = retire_key_id
        elif retire_key_id is not None and retire_key_id != s["nextRetireKeyId"]:
            raise ValueError("Resume the pending key rotation before changing retirement")
        self.save()
        body = {"deliveryPublicKey": s["nextKey"]["publicKey"]}
        if s["nextRetireKeyId"]:
            body["retireKeyId"] = s["nextRetireKeyId"]
        self.client.request("/v3/service", s["serviceToken"], body, "PATCH")
        if all(key["id"] != s["nextKey"]["id"] for key in s["keys"]):
            s["keys"].append(s["nextKey"])
        del s["nextKey"]
        del s["nextRetireKeyId"]
        self.save()

    def connection(self, connection_id):
        return Connection(self.client, self.state["connections"][connection_id]["token"])


class Connection:
    def __init__(self, client, token):
        self.client, self.token = client, token

    def status(self):
        return self.client.request("/v3/connection", self.token)

    def request_form(self, definition):
        return self.client.request("/v2/requests", self.token, definition)

    def get_form(self, request_id):
        return self.client.request("/v2/requests/" + quote(request_id, safe=""), self.token)

    def form_result(self, request_id):
        return self.client.request("/v2/requests/" + quote(request_id, safe="") + "/result", self.token)

    def cancel_form(self, request_id):
        return self.client.request("/v2/requests/" + quote(request_id, safe="") + "/cancel", self.token, {})

    def request_sms(self, definition):
        return self.client.request("/v1/requests", self.token, definition)

    def get_sms(self, request_id):
        return self.client.request("/v1/requests/" + quote(request_id, safe=""), self.token)

    def cancel_sms(self, request_id):
        return self.client.request("/v1/requests/" + quote(request_id, safe="") + "/cancel", self.token, {})

    def events(self, cursor=None):
        return self.client.request("/v2/events" + ("?cursor=" + quote(cursor, safe="") if cursor else ""), self.token)

    def register_webhook(self, definition):
        return self.client.request("/v2/webhooks", self.token, definition)

    def webhooks(self):
        return self.client.request("/v2/webhooks", self.token)

    def delete_webhook(self, webhook_id):
        return self.client.request("/v2/webhooks/" + quote(webhook_id, safe=""), self.token, method="DELETE")
