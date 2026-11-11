package relay
import("context";"encoding/json";"testing")
func TestPrivateProcessTransport(t *testing.T){
 client:=Client{Broker:"../../scripts/sdk-broker-fixture.py",Profile:"conformance"}
 value,err:=client.Status(context.Background(),map[string]any{},"public-connection");if err!=nil{t.Fatal(err)}
 var status map[string]any;if json.Unmarshal(value,&status)!=nil||status["setup"]!="setup_complete"{t.Fatal("status response missing")}
 if _,err=client.RequestSms(context.Background(),map[string]any{},"public-connection");err==nil||err.Error()!="sms_approval_required"{t.Fatal("permission error missing")}
}
