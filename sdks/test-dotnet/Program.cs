using Bluegrain.RequestRelay;
var client=new RelayClient(args[0],"conformance");
if((await client.StatusAsync(connectionId:"public-connection")).GetProperty("setup").GetString()!="setup_complete")throw new Exception("missing status");
try {await client.RequestSmsAsync(connectionId:"public-connection");throw new Exception("permission error missing");}
catch(InvalidOperationException error) {if(error.Message!="sms_approval_required")throw;}
