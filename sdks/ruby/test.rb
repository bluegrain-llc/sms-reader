require_relative 'lib/request_relay'
require 'minitest/autorun'
class TransportTest < Minitest::Test
 def test_process_transport
  client=RequestRelay::Client.new(broker: File.expand_path('../../scripts/sdk-broker-fixture.py',__dir__),profile:'conformance')
  assert_equal 'setup_complete',client.status(connection_id:'public-connection')['setup']
  assert_equal 'sms_approval_required',assert_raises(RuntimeError){client.request_sms(connection_id:'public-connection')}.message
 end
end
