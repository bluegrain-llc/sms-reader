import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { RecoveryObjects } from './security-ledger.js';
import { snapshotMetadata, restoreMetadata } from './recovery.js';
import { ensure } from './model.js';

const [command, ...args] = process.argv.slice(2);
const setting = (name: string) => { const i = args.indexOf(`--${name}`); ensure(i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--'), 400, `missing_${name}`); return args[i + 1]!; };
try {
  ensure(command === 'backup' || command === 'restore', 400, 'expected_backup_or_restore');
  const project = setting('project');
  ensure(!process.env.FIRESTORE_EMULATOR_HOST && !process.env.FIREBASE_AUTH_EMULATOR_HOST, 400, 'recovery_cli_requires_real_explicit_project');
  const destination = command === 'restore' ? setting('destination-project') : project;
  if (command === 'restore') ensure(args.includes('--acknowledge-empty-offline-destination'), 400, 'offline_destination_acknowledgement_required');
  initializeApp({ projectId: destination });
  const db = getFirestore(), backup = new RecoveryObjects(setting('backup-bucket')), ledger = new RecoveryObjects(setting('ledger-bucket'));
  const result = command === 'backup' ? await snapshotMetadata(db, project, backup, ledger)
    : await restoreMetadata(db, project, backup, setting('snapshot'), ledger, uid => getAuth().deleteUser(uid));
  console.log(JSON.stringify({ command, project, destination, ...result }));
  await db.terminate();
} catch { console.error('recovery_operation_failed'); process.exitCode = 1; }
