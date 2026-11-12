import UIKit
import AuthenticationServices
import CryptoKit
import FirebaseAuth
import FirebaseCore
import GoogleSignIn

enum AuthAction: Equatable { case signIn, reauthenticate, link }
@MainActor
final class Authentication: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>?
    private var controller: ASAuthorizationController?
    private var nonce = ""
    var configured: Bool { FirebaseApp.app() != nil }
    var user: User? { configured ? Auth.auth().currentUser : nil }
    private var presenter: UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var view = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = view?.presentedViewController { view = presented }; return view
    }
    func authenticate(provider: String, action: AuthAction) async throws -> String? {
        guard configured else { throw RelayFailure.configuration }
        let credential: AuthCredential, code: String?
        let expected = user?.uid
        if provider == "apple.com" {
            guard continuation == nil else { throw RelayFailure.authentication }
            var data = Data(count: 32)
            guard data.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw RelayFailure.authentication }
            nonce = data.base64url
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email, .fullName]
            request.nonce = Data(SHA256.hash(data: Data(nonce.utf8))).hex
            let result: ASAuthorizationAppleIDCredential = try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let controller = ASAuthorizationController(authorizationRequests: [request]); self.controller = controller
                controller.delegate = self; controller.presentationContextProvider = self; controller.performRequests()
            }
            defer { nonce = "" }
            guard let token = result.identityToken.flatMap({ String(data: $0, encoding: .utf8) }) else { throw RelayFailure.authentication }
            credential = OAuthProvider.appleCredential(withIDToken: token, rawNonce: nonce, fullName: result.fullName)
            code = result.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        } else {
            guard provider == "google.com", let presenter, let clientID = FirebaseApp.app()?.options.clientID else { throw RelayFailure.configuration }
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
            guard let token = result.user.idToken?.tokenString else { throw RelayFailure.authentication }
            credential = GoogleAuthProvider.credential(withIDToken: token, accessToken: result.user.accessToken.tokenString)
            code = nil
        }
        switch action {
        case .signIn:
            guard user == nil else { throw RelayFailure.authentication }
            _ = try await Auth.auth().signIn(with: credential)
        case .reauthenticate:
            guard let user else { throw RelayFailure.authentication }; _ = try await user.reauthenticate(with: credential)
        case .link:
            guard let user else { throw RelayFailure.authentication }; _ = try await user.link(with: credential)
        }
        guard action == .signIn || user?.uid == expected else { throw RelayFailure.authentication }
        return code
    }
    func prepareDeletion() async throws {
        guard let user else { throw RelayFailure.authentication }
        // A linked Apple account must revoke Apple authorization even if Google was used last.
        if user.providerData.contains(where: { $0.providerID == "apple.com" }) {
            guard let code = try await authenticate(provider: "apple.com", action: .reauthenticate) else { throw RelayFailure.authentication }
            try await Auth.auth().revokeToken(withAuthorizationCode: code)
        } else { _ = try await authenticate(provider: "google.com", action: .reauthenticate) }
    }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { presenter?.view.window ?? UIWindow() }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else { continuation?.resume(throwing: RelayFailure.authentication); continuation = nil; self.controller = nil; return }
        continuation?.resume(returning: credential); continuation = nil; self.controller = nil
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: RelayFailure.authentication); continuation = nil; self.controller = nil
    }
}
