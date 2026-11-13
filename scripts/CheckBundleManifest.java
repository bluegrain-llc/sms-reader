import com.android.aapt.Resources.XmlAttribute;
import com.android.aapt.Resources.XmlElement;
import com.android.aapt.Resources.XmlNode;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Checks information lost by bundletool's XML dump, using its AAPT protobuf schema. */
class CheckBundleManifest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    public static void main(String[] args) throws Exception {
        int count = Integer.parseInt(args[1]);
        Map<String, Integer> ids = new HashMap<>();
        Map<Integer, String> names = new HashMap<>();
        for (int i = 2; i < 2 + count; i++) {
            String[] pair = args[i].split("=", -1);
            int id = Integer.parseUnsignedInt(pair[1], 16);
            if (ids.put(pair[0], id) != null || names.put(id, pair[0]) != null) {
                throw new IllegalArgumentException("Duplicate manifest attribute policy");
            }
        }
        try (ZipFile bundle = new ZipFile(args[0])) {
            for (int i = 2 + count; i < args.length; i++) {
                ZipEntry entry = bundle.getEntry(args[i] + "/manifest/AndroidManifest.xml");
                if (entry == null) {
                    throw new IllegalArgumentException("Missing module manifest");
                }
                try (InputStream input = bundle.getInputStream(entry)) {
                    inspect(XmlNode.parseFrom(input), ids, names);
                }
            }
        }
    }

    private static void inspect(XmlNode root, Map<String, Integer> ids,
                                Map<Integer, String> names) {
        if (!root.hasElement() || !root.getElement().getName().equals("manifest")) {
            throw new IllegalArgumentException("Invalid manifest root");
        }
        ArrayDeque<XmlNode> pending = new ArrayDeque<>();
        pending.add(root);
        while (!pending.isEmpty()) {
            XmlNode node = pending.remove();
            if (!node.hasElement()) {
                continue;
            }
            XmlElement element = node.getElement();
            Set<List<String>> attributes = new HashSet<>();
            Set<Integer> protectedIds = new HashSet<>();
            for (XmlAttribute attribute : element.getAttributeList()) {
                String name = attribute.getName();
                String namespace = attribute.getNamespaceUri();
                int id = attribute.getResourceId();
                Integer expectedId = ids.get(name);
                String expectedName = names.get(id);
                if (!attributes.add(List.of(namespace, name))) {
                    throw new IllegalArgumentException("Duplicate manifest attribute");
                }
                if (expectedId != null || expectedName != null) {
                    if (expectedId == null || expectedId != id || !name.equals(expectedName)
                            || (!namespace.isEmpty() && !namespace.equals(ANDROID_NS))
                            || !protectedIds.add(id)) {
                        throw new IllegalArgumentException("Ambiguous Android manifest attribute identity");
                    }
                }
            }
            pending.addAll(element.getChildList());
        }
    }
}
