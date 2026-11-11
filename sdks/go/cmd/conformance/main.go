// Synthetic conformance driver; no credentials are returned by the SDK lifecycle API.
package main

import (
	"context"
	"encoding/json"
	relay "github.com/bluegrain-llc/sms-reader/sdks/go"
	"os"
)

func main() {
	var r struct {
		Broker, Profile, Directory, RelayURL, StorageCommand, Operation, ConnectionID string
		Input                                                                         json.RawMessage
	}
	if json.NewDecoder(os.Stdin).Decode(&r) != nil {
		os.Exit(2)
	}
	v, e := (relay.Client{Broker: r.Broker, Profile: r.Profile, Directory: r.Directory, RelayURL: r.RelayURL, StorageCommand: r.StorageCommand}).Invoke(context.Background(), r.Operation, r.Input, r.ConnectionID)
	if e != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false})
		return
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "value": v})
}
