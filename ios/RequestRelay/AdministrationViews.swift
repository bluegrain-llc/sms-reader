import SwiftUI
import UniformTypeIdentifiers
import FirebaseAuth

struct SignInPanel: View {
    @EnvironmentObject var model: RelayModel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Your approval, every time.").font(.largeTitle.weight(.semibold))
            Text("Review requests from connected agents and choose what to share.").foregroundStyle(.secondary)
            if model.authentication.configured {
                Button("Continue with Google") { Task { await model.signIn("google.com") } }.buttonStyle(.borderedProminent)
                Button("Continue with Apple") { Task { await model.signIn("apple.com") } }.buttonStyle(.bordered)
            } else { Text("Install a build configured with this relay’s Firebase project and HTTPS origin.") }
        }.padding(24).disabled(model.busy)
    }
}
struct Administration: View {
    @EnvironmentObject var model: RelayModel
    @State private var linkProvider: String?
    @State private var deletion = false
    @State private var scanner = false
    @State private var manualLink = ""
    var body: some View {
        List {
            Section("Access") {
                NavigationLink("Agents · Create and manage") { AgentsScreen() }
                Button("Scan registration or connection QR") { scanner = true }
                TextField("HTTPS approval link", text: $manualLink).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Review link") { if let url = URL(string: manualLink) { model.open(url) } }.disabled(manualLink.isEmpty)
                ForEach(model.grants) { grant in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(grant.callerName).font(.headline)
                        Text(grant.revoked || grant.expiresAt <= Date().timeIntervalSince1970 * 1000 ? "Disconnected" : (grant.capabilities ?? ["sms"]).joined(separator: " · ")).foregroundStyle(.secondary)
                        if !grant.revoked {
                            if let id = grant.connectionId { Button("Manage permissions") { model.destination = .init(kind: "connections", value: id) } }
                            else { Toggle("Allow forms and decisions", isOn: Binding(get: { grant.formsApproved ?? false }, set: { approved in
                                Task { await model.perform { let _: EmptyReply = try await model.api.call("/v2/grants/\(grant.id)/forms", method: "PUT", body: ["approved":approved]); await model.refresh() } }
                            })) }
                            Button("Disconnect", role: .destructive) { Task { await model.perform { let _: EmptyReply = try await model.api.call("/v1/grants/\(grant.id)", method: "DELETE"); await model.refresh() } } }
                        }
                    }
                }
            }
            Section("Devices") {
                Button("Connect this device") { Task { await model.perform { try await model.registerDevice() } } }
                ForEach(model.devices) { device in
                    VStack(alignment: .leading) {
                        Text(device.name).font(.headline)
                        Toggle("Receive requests", isOn: Binding(get: { !device.paused }, set: { value in Task { await model.perform {
                            let _: EmptyReply = try await model.api.call("/v1/devices/\(device.id)", method: "PATCH", body: ["paused":!value]); await model.refresh()
                        } } }))
                        Button("Remove device", role: .destructive) { Task { await model.perform {
                            try await model.removeDevice(device.id)
                        } } }
                    }
                }
            }
            Section("History") {
                ForEach(model.history) { row in VStack(alignment: .leading) { Text(row.callerName).font(.headline); Text(row.status.replacingOccurrences(of: "_", with: " ")).foregroundStyle(.secondary) } }
                if model.history.isEmpty { Text("No history yet.").foregroundStyle(.secondary) }
            }
            Section("Account") {
                Text(model.identity)
                Text("Link providers only if you want both sign-in methods to use this account. Existing accounts are never merged by email.").font(.footnote).foregroundStyle(.secondary)
                ForEach(["google.com","apple.com"], id: \.self) { provider in
                    if !(model.authentication.user?.providerData.contains(where: { $0.providerID == provider }) ?? false) {
                        Button(provider == "google.com" ? "Link Google account" : "Link Apple account") { linkProvider = provider }
                    }
                }
                Button("Sign out") { model.clearResponses(); try? Auth.auth().signOut() }
                Button("Delete account", role: .destructive) { deletion = true }
                Link("Privacy policy", destination: model.api.origin.appendingPathComponent("privacy"))
            }
        }.navigationTitle("Administration").refreshable { await model.refresh() }.disabled(model.busy)
        .sheet(isPresented: $scanner) { QRScanner { url in scanner = false; model.open(url) } }
        .confirmationDialog("Link this provider to your current account?", isPresented: Binding(get: { linkProvider != nil }, set: { if !$0 { linkProvider = nil } }), titleVisibility: .visible) {
            if let provider = linkProvider { Button("I consent to link accounts") { Task { await model.signIn(provider, action: .link) }; linkProvider = nil } }
        }
        .confirmationDialog("Permanently delete your relay account and data?", isPresented: $deletion, titleVisibility: .visible) {
            Button("Verify identity and delete", role: .destructive) { Task { await model.perform { try await model.deleteAccount() } } }
        } message: { Text("Devices, connections and responses will be removed. Apple authorization is revoked when linked. Server cleanup continues after acceptance.") }
    }
}
struct TicketDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { guard let data = configuration.file.regularFileContents else { throw RelayFailure.storage }; self.data = data }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
struct AgentsScreen: View {
    @EnvironmentObject var model: RelayModel
    @State private var name = ""
    @State private var purpose = ""
    @State private var forms = true
    @State private var sms = false
    @State private var ticket: SessionTicket?
    @State private var document: TicketDocument?
    @State private var exporting = false
    @State private var clear = false
    @State private var deleting: Agent?
    @State private var ticketOwner: String?
    var body: some View {
        Form {
            Section("Create agent") {
                Text("Save a private session ticket and supply it to your agent. Registration grants no access; connecting requires a separate approval.").font(.footnote).foregroundStyle(.secondary)
                if let ticket {
                    Text("Retained ticket for \(ticket.agent.name)")
                    Button("Save session ticket") { provision(ticket) }
                    Button("Clear retained ticket", role: .destructive) { clear = true }
                } else {
                    TextField("Name", text: $name).onChange(of: name) { _, value in name = String(value.prefix(80)) }
                    TextField("Description", text: $purpose, axis: .vertical).onChange(of: purpose) { _, value in purpose = String(value.prefix(240)) }
                    Toggle("Forms and decisions", isOn: $forms); Toggle("SMS codes", isOn: $sms)
                    Button("Create agent and save ticket") {
                        Task { await model.perform {
                            guard let uid = model.authentication.user?.uid else { throw RelayFailure.authentication }
                            let ticket = try SessionTicket.create(origin: model.api.origin, agent: .init(name: name.trimmingCharacters(in: .whitespacesAndNewlines), purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines), capabilities: (forms ? ["forms"] : []) + (sms ? ["sms"] : [])))
                            try RetainedTicketStore.saveNew(ticket, owner: uid); self.ticket = ticket; ticketOwner = uid
                            let _: Agent = try await model.api.call("/v3/services", method: "POST", body: ticket.declaration)
                            guard model.authentication.user?.uid == uid else { throw RelayFailure.authentication }
                            try RetainedTicketStore.verify(ticket, owner: uid)
                            document = TicketDocument(data: try JSONEncoder().encode(ticket)); exporting = true; await model.refresh()
                        } }
                    }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!forms && !sms))
                }
            }
            Section("Your agents") {
                ForEach(model.agents) { agent in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(agent.name).font(.headline); Text(agent.purpose).foregroundStyle(.secondary)
                        Text(agent.capabilities.joined(separator: " · ")).font(.caption)
                        ShareLink("Share connection link", item: model.api.origin.appendingPathComponent("services/\(agent.id)"))
                        PublicQRCode(url: model.api.origin.appendingPathComponent("services/\(agent.id)"))
                        Button("Connect to agent") { model.destination = .init(kind: "services", value: agent.id) }
                        Button(agent.active ? "Disable agent" : "Enable agent") { Task { await model.perform {
                            let _: Agent = try await model.api.call("/v3/services/\(agent.id)", method: "PATCH", body: ["active":!agent.active]); await model.refresh()
                        } } }
                        Button("Delete agent", role: .destructive) { deleting = agent }
                    }
                }
                if model.agents.isEmpty { Text("No agents registered.").foregroundStyle(.secondary) }
            }
        }.navigationTitle("Agents").disabled(model.busy)
        .task(id: model.authentication.user?.uid) {
            ticket = nil; document = nil; exporting = false; ticketOwner = model.authentication.user?.uid
            guard let uid = ticketOwner else { return }
            do { ticket = try RetainedTicketStore.read(owner: uid) } catch { model.error = RelayFailure.storage.localizedDescription }
        }
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "agent-session-ticket") { result in
            switch result { case .success: model.notice = "Ticket saved. Supply it privately to your agent."; case .failure: model.error = "Ticket was not saved. Your provisioning state is retained for retry." }
        }
        .confirmationDialog("Confirm the ticket is safely saved before clearing its retained copy.", isPresented: $clear, titleVisibility: .visible) { Button("Clear retained ticket", role: .destructive) {
            do {
                guard let ticket, let uid = ticketOwner, model.authentication.user?.uid == uid else { throw RelayFailure.authentication }
                try RetainedTicketStore.clear(ticket, owner: uid); self.ticket = nil; document = nil
            } catch { model.error = RelayFailure.storage.localizedDescription }
        } }
        .confirmationDialog("Delete this agent and disconnect every recipient?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let agent = deleting { Button("Delete agent", role: .destructive) { Task { await model.perform { let _: Agent = try await model.api.call("/v3/services/\(agent.id)", method: "DELETE"); await model.refresh() } }; deleting = nil } }
        }
    }
    private func provision(_ ticket: SessionTicket) {
        Task { await model.perform {
            guard let uid = ticketOwner, model.authentication.user?.uid == uid else { throw RelayFailure.authentication }
            try RetainedTicketStore.verify(ticket, owner: uid)
            let _: Agent = try await model.api.call("/v3/services", method: "POST", body: ticket.declaration)
            guard model.authentication.user?.uid == uid else { throw RelayFailure.authentication }
            try RetainedTicketStore.verify(ticket, owner: uid)
            document = TicketDocument(data: try JSONEncoder().encode(ticket)); exporting = true; await model.refresh()
        } }
    }
}
