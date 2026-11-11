"""Build real language SDK drivers; emits only a public command manifest."""
import json, os, subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
out=root/'artifacts/sdk-conformance';out.mkdir(parents=True,exist_ok=True)
def run(argv):subprocess.run(argv,cwd=root,check=True)
subprocess.run(['go','build','-o',str(out/'go'),'./cmd/conformance'],cwd=root/'sdks/go',check=True)
run(['cargo','build','--manifest-path','sdks/rust/Cargo.toml','--locked','--example','conformance'])
run(['dotnet','build','sdks/conformance-dotnet/Conformance.csproj','-o',str(out/'dotnet'),'--nologo'])
run(['mvn','-q','-f','sdks/java/pom.xml','package','dependency:build-classpath','-Dmdep.outputFile='+str(out/'java-classpath')])
cp=os.pathsep.join([str(root/'sdks/java/target/classes'),str(root/'sdks/java/target/test-classes'),(out/'java-classpath').read_text().strip()])
commands={'javascript':['node',str(root/'cli/broker.mjs')],'python':[sys.executable,str(root/'scripts/sdk-python-conformance.py')],'go':[str(out/'go')],'java':['java','-cp',cp,'llc.bluegrain.relay.Conformance'],'dotnet':['dotnet',str(out/'dotnet/Conformance.dll')],'rust':[str(root/'sdks/rust/target/debug/examples/conformance')],'php':['php',str(root/'sdks/php/conformance.php')],'ruby':['ruby',str(root/'sdks/ruby/conformance.rb')]}
(out/'commands.json').write_text(json.dumps(commands))
print('Built eight SDK conformance drivers: '+str(out/'commands.json'))
