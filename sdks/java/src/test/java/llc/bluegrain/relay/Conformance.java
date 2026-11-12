package llc.bluegrain.relay;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
public final class Conformance {
 public static void main(String[] args)throws Exception{
  var json=new ObjectMapper();var r=json.readTree(System.in);
  var client=new RelayClient(r.path("broker").asText(),r.path("profile").asText(),r.path("directory").asText(null),r.path("relayUrl").asText(null),r.path("storageCommand").asText(null));
  try{var value=client.invoke(r.path("operation").asText(),r.path("input"),r.path("connectionId").asText(null));json.writeValue(System.out,Map.of("ok",true,"value",value));}
  catch(Exception e){json.writeValue(System.out,Map.of("ok",false));}
 }
}
