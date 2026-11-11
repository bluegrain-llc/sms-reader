<?php
require __DIR__.'/RelayClient.php';
$r=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$c=new Bluegrain\RequestRelay\RelayClient($r['broker'],$r['profile'],$r['directory']??null,$r['relayUrl']??null,$r['storageCommand']??null);
try {echo json_encode(['ok'=>true,'value'=>$c->invoke($r['operation'],$r['input']??[],$r['connectionId']??null)],JSON_THROW_ON_ERROR);}
catch(Throwable $error){echo '{"ok":false}';}
