# Relay and Admin

The Android app's Admin area manages app/bot access directly. The earlier external-manager approach is superseded and its issuance endpoints have been removed.

See [direct pairing design](PAIRING_DESIGN.md): bot requests connection → owner opens its link → owner approves in Admin → the bot's individual credential becomes usable. No master credential is created or copied on the phone.

Relay keeps the message-by-message Android consent flow. A user may register multiple phones; active SMS requests notify all available phones, each has its own consent gate, and the first approved result wins. Further callers queue without competing for one incoming SMS.
