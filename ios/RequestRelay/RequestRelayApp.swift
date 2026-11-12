import SwiftUI
import FirebaseCore
import FirebaseAuth
import FirebaseMessaging
import GoogleSignIn
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate, MessagingDelegate {
    static weak var model: RelayModel?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if FirebaseApp.app() != nil { Messaging.messaging().delegate = self; Messaging.messaging().isAutoInitEnabled = true }
        if let payload = options?[.remoteNotification] as? [AnyHashable: Any] { retain(payload) }
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard FirebaseApp.app() != nil else { return }; Messaging.messaging().apnsToken = deviceToken
        Task { try? await Self.model?.updatePushToken() }
    }
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in try? await Self.model?.updatePushToken() }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let payload = response.notification.request.content.userInfo
        await MainActor.run { self.retain(payload) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await Self.model?.refresh(); return [.banner,.sound]
    }
    private func retain(_ payload: [AnyHashable: Any]) {
        guard let id = payload["requestId"] as? String, id.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil else { return }
        // Public identifiers only. Fetch content after authenticated opening.
        UserDefaults.standard.set(id, forKey: "notification-id")
        UserDefaults.standard.set(payload["kind"] as? String == "form" ? "form" : "sms", forKey: "notification-kind")
        Self.model?.notificationRequest = id
    }
    func applicationWillTerminate(_ application: UIApplication) { Self.model?.clearResponses() }
}
@main
struct RequestRelayApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model: RelayModel
    init() {
        if FirebaseApp.app() == nil, let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"), let options = FirebaseOptions(contentsOfFile: path) { FirebaseApp.configure(options: options) }
        let model = RelayModel(); _model = StateObject(wrappedValue: model); AppDelegate.model = model
    }
    var body: some Scene { WindowGroup { RelayRoot().environmentObject(model).tint(Color(red: 0, green: 0.42, blue: 0.37)).onOpenURL { url in
        if !GIDSignIn.sharedInstance.handle(url) { model.open(url) }
    }.onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in if let url = activity.webpageURL { model.open(url) } } } }
}
struct NotificationTarget: Identifiable { let id: String; let kind: String }
struct RelayRoot: View {
    @EnvironmentObject var model: RelayModel
    @Environment(\.scenePhase) private var phase
    @State private var notification: NotificationTarget?
    var body: some View {
        ZStack {
            Group {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-contract") { UIContractHarness() }
                else { authenticatedContent }
                #else
                authenticatedContent
                #endif
            }
            if phase != .active { Color(uiColor: .systemBackground).ignoresSafeArea(); Label("Request Relay", systemImage: "lock.shield").font(.title) }
        }
        .sheet(item: $model.destination) { target in
            if target.kind == "agents" { NavigationStack { Group { if model.signedIn { AgentsScreen() } else { SignInPanel() } }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { model.closeDestination() } } } } }
            else { OnboardingView(target: target) }
        }
        .sheet(item: $notification) { target in NavigationStack {
            Group { if target.kind == "form" { FormResponse(id: target.id, fromNotification: true) } else { CodeResponse(id: target.id) } }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { notification = nil } } }
        } }
        .alert("Request Relay", isPresented: Binding(get: { model.error != nil || model.notice != nil }, set: { if !$0 { model.error = nil; model.notice = nil } })) {
            Button("OK") { model.error = nil; model.notice = nil }
        } message: { Text(model.error ?? model.notice ?? "") }
        .onChange(of: phase) { _, phase in if phase == .active { Task { await model.refresh(); routeNotification() } } }
        .onChange(of: model.destination) { _, value in if value == nil { UserDefaults.standard.removeObject(forKey: "public-destination"); routeNotification() } }
        .onChange(of: model.notificationRequest) { _, _ in routeNotification() }
        .onChange(of: model.signedIn) { _, _ in routeNotification() }
        .task(id: phase) {
            guard phase == .active else { return }; routeNotification()
            while !Task.isCancelled { model.expireDrafts(); await model.refresh(); try? await Task.sleep(for: .seconds(5)) }
        }
    }
    @ViewBuilder private var authenticatedContent: some View {
                if model.signedIn {
                    TabView(selection: $model.selectedTab) {
                        NavigationStack { RequestInbox() }.tabItem { Label("Inbox", systemImage: "tray") }.tag(0)
                        NavigationStack { Administration() }.tabItem { Label("Administration", systemImage: "person.badge.key") }.tag(1)
                    }
                } else { NavigationStack { SignInPanel().navigationTitle("Request Relay") } }
            }
    private func routeNotification() {
        guard model.signedIn, model.destination == nil, let id = UserDefaults.standard.string(forKey: "notification-id") else { return }
        notification = .init(id: id, kind: UserDefaults.standard.string(forKey: "notification-kind") ?? "sms")
        UserDefaults.standard.removeObject(forKey: "notification-id"); UserDefaults.standard.removeObject(forKey: "notification-kind")
        model.notificationRequest = nil
    }
}
