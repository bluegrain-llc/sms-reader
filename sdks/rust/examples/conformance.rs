use request_relay_client::Client;
use serde_json::{Value,json};
fn main(){let r:Value=serde_json::from_reader(std::io::stdin()).unwrap();let text=|k:&str|r[k].as_str().map(str::to_owned);let c=Client{broker:text("broker").unwrap(),profile:text("profile").unwrap(),directory:text("directory"),relay_url:text("relayUrl"),storage_command:text("storageCommand")};let result=c.invoke(r["operation"].as_str().unwrap(),r["input"].clone(),r["connectionId"].as_str());println!("{}",match result{Ok(v)=>json!({"ok":true,"value":v}),Err(_)=>json!({"ok":false})});}
