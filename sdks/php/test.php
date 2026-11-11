<?php
require __DIR__.'/RelayClient.php';
$client=new Bluegrain\RequestRelay\RelayClient(realpath(__DIR__.'/../../scripts/sdk-broker-fixture.py'),'conformance');
if($client->status([], 'public-connection')['setup']!=='setup_complete')throw new RuntimeException('missing status');
try{$client->requestSms([], 'public-connection');throw new RuntimeException('permission error missing');}
catch(RuntimeException $e){if($e->getMessage()!=='sms_approval_required')throw $e;}
