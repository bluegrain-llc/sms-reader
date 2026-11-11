package llc.bluegrain.relay;
import java.util.Map;
public final class Smoke {
 public static void main(String[] args)throws Exception{
  var client=new RelayClient(args[0],"conformance",null,null);
  if(!client.status(Map.of(),"public-connection").get("setup").asText().equals("setup_complete"))throw new AssertionError("status missing");
  try{client.requestSms(Map.of(),"public-connection");throw new AssertionError("permission error missing");}
  catch(IllegalStateException error){if(!error.getMessage().equals("sms_approval_required"))throw error;}
 }
}
