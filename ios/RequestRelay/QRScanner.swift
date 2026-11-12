import SwiftUI
import AVFoundation

struct QRScanner: View {
    let receive: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var granted = false
    var body: some View {
        NavigationStack {
            Group { if granted { CameraScanner(receive: receive).ignoresSafeArea(edges: .bottom) }
                else { ContentUnavailableView("Camera access required", systemImage: "qrcode.viewfinder", description: Text("Allow camera access in Settings, or paste the HTTPS link in Administration.")) } }
                .navigationTitle("Scan agent QR")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .task { granted = await AVCaptureDevice.requestAccess(for: .video) }
        }
    }
}
struct CameraScanner: UIViewControllerRepresentable {
    let receive: (URL) -> Void
    func makeUIViewController(context: Context) -> CameraController { CameraController(receive: receive) }
    func updateUIViewController(_ uiViewController: CameraController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: CameraController, coordinator: ()) { uiViewController.stop() }
}
final class CameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession(), queue = DispatchQueue(label: "relay.qr.camera")
    private let receive: (URL) -> Void
    private var preview: AVCaptureVideoPreviewLayer?
    private var received = false
    init(receive: @escaping (URL) -> Void) { self.receive = receive; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { return nil }
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), capture.canAddInput(input) else { return }
        capture.addInput(input); let output = AVCaptureMetadataOutput(); guard capture.canAddOutput(output) else { return }; capture.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: capture); preview.videoGravity = .resizeAspectFill; view.layer.addSublayer(preview); self.preview = preview
        queue.async { [capture] in capture.startRunning() }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    func stop() { queue.async { [capture] in capture.stopRunning() } }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !received, let raw = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, let url = URL(string: raw), url.scheme == "https" else { return }
        received = true; stop(); receive(url)
    }
}
