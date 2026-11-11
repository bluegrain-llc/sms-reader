using System.Text.Json;
using Bluegrain.RequestRelay;
using var r=JsonDocument.Parse(await Console.In.ReadToEndAsync());
string? text(string k)=>r.RootElement.TryGetProperty(k,out var v)?v.GetString():null;
var client=new RelayClient(text("broker"),text("profile")!,text("directory"),text("relayUrl"),text("storageCommand"));
try{var v=await client.InvokeAsync(text("operation")!,r.RootElement.TryGetProperty("input",out var input)?input:null,text("connectionId"));Console.WriteLine(JsonSerializer.Serialize(new{ok=true,value=v}));}
catch(Exception){Console.WriteLine("{\"ok\":false}");}
