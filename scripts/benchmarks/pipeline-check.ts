/** Proves the $min/$add pipeline update clamps AND composes under concurrency. */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Gym, Faction } from '../../src/models/gym.model';

(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(rs.getUri());

  let n = 0;
  const mk = (cp: number) => Gym.create({
    name: `Test Gym ${n++}`, locationName: 'Siebel Basement', latitude: 40.1, longitude: -88.2,
    controllingFaction: Faction.NEUTRAL, controlPoints: cp, maxControlPoints: 1000,
    defenders: [], version: 0, isShielded: false,
  });

  const boost = (id: mongoose.Types.ObjectId) => Gym.findByIdAndUpdate(id, [
    { $set: { controlPoints: { $min: [{ $add: ['$controlPoints', 250] }, '$maxControlPoints'] },
              version: { $add: ['$version', 1] } } },
  ], { new: true });

  let g = await mk(100);
  let r = await boost(g._id);
  console.log(`add:    100 + 250 -> ${r!.controlPoints}  (expect 350)  version=${r!.version} (expect 1)`);

  g = await mk(900);
  r = await boost(g._id);
  console.log(`clamp:  900 + 250 -> ${r!.controlPoints}  (expect 1000, capped)`);

  g = await mk(0);
  await Promise.all([boost(g._id), boost(g._id), boost(g._id), boost(g._id)]);
  let after = await Gym.findById(g._id);
  console.log(`NEW:    4x250 from 0 -> ${after!.controlPoints}  (expect 1000)  version=${after!.version} (expect 4)`);

  g = await mk(0);
  const old = async () => {
    const doc = await Gym.findById(g._id);
    const capped = Math.min(doc!.maxControlPoints, doc!.controlPoints + 250);
    await Gym.findByIdAndUpdate(g._id, { $set: { controlPoints: capped } });
  };
  await Promise.all([old(), old(), old(), old()]);
  after = await Gym.findById(g._id);
  console.log(`OLD:    4x250 from 0 -> ${after!.controlPoints}  (lost updates)`);

  await mongoose.disconnect(); await rs.stop(); process.exit(0);
})();
