import type { Relay } from './relay.js';

/** Durable bounded cleanup, independent of the caller remaining online after revocation. */
export async function cleanupOAuth(relay: Relay) {
  for (const job of (await relay.db.collection('oauthGrantCleanup').limit(20).get()).docs) await relay.db.runTransaction(async tx => {
    const value = (await tx.get(job.ref)).data(); if (!value) return;
    const families = await tx.get(relay.db.collection('oauthFamilies').where('grantId','==',value.grantId).limit(100));
    const queued = await Promise.all(families.docs.map(f => tx.get(relay.ref('oauthCleanup',f.id))));
    families.docs.forEach((f,i)=>{if(!queued[i]!.exists)tx.create(relay.ref('oauthCleanup',f.id),{familyId:f.id,ownerId:value.ownerId,serviceId:value.serviceId,collectionIndex:0});});
    if(families.empty)tx.delete(job.ref);
  });
  for (const job of (await relay.db.collection('oauthCleanup').limit(20).get()).docs) await relay.db.runTransaction(async tx => {
    const value=(await tx.get(job.ref)).data();if(!value)return;
    const collection=['oauthAccess','oauthRefresh','oauthCodes'][value.collectionIndex];
    if(!collection){tx.delete(relay.ref('oauthFamilies',value.familyId));tx.delete(job.ref);return;}
    const rows=await tx.get(relay.db.collection(collection).where('familyId','==',value.familyId).limit(100));
    for(const row of rows.docs)tx.delete(row.ref);
    if(rows.size<100)tx.update(job.ref,{collectionIndex:value.collectionIndex+1});
  });
}
