require_relative 'lib/request_relay'
r=JSON.parse(STDIN.read)
c=RequestRelay::Client.new(broker:r['broker'],profile:r['profile'],directory:r['directory'],relay_url:r['relayUrl'],storage_command:r['storageCommand'])
begin
 puts JSON.generate({ok:true,value:c.invoke(r['operation'],input:r['input']||{},connection_id:r['connectionId'])})
rescue
 puts JSON.generate({ok:false})
end
