import "./guardEnv.ts";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.ts";

export async function createDoLocalFixture() {
  // Rollup includes retention: only a separately named disposable DO test DB may run it.
  const target = new URL(process.env.DATABASE_URL!);
  if (!/^\/truaquality_do_test(?:_[a-z0-9]+)?$/.test(target.pathname)) {
    throw new Error("DO local SQL prerequisite: provide a disposable localhost truaquality_do_test database with project migrations applied; ordinary fake-suite test.env is intentionally unreachable");
  }
  await prisma.$queryRaw`SELECT "pondId", "parameter", "bucketStart", "sum", "count", "min", "max" FROM "ReadingHourly" LIMIT 0`;
  const [session] = await prisma.$queryRaw<{timezone: string}[]>`SELECT current_setting('TimeZone') AS timezone`;
  if (session.timezone !== "UTC" && session.timezone !== "Etc/UTC") {
    throw new Error("DO local SQL prerequisite: disposable database sessions must use UTC for UTC-naive Reading timestamps");
  }
  const pondId = randomUUID();
  const deviceId = randomUUID();
  const profileIds: string[] = [];
  const cleanup = async () => {
    await prisma.notification.deleteMany({where: {alert: {pondId}}});
    await prisma.alert.deleteMany({where: {pondId}});
    await prisma.reading.deleteMany({where: {pondId}});
    await prisma.readingHourly.deleteMany({where: {pondId}});
    await prisma.deviceEvent.deleteMany({where: {deviceId}});
    await prisma.device.deleteMany({where: {id: deviceId}});
    await prisma.pond.deleteMany({where: {id: pondId}});
    await prisma.notification.deleteMany({where: {profileId: {in: profileIds}}});
    await prisma.profile.deleteMany({where: {id: {in: profileIds}}});
  };
  try {
    const pond = await prisma.pond.create({data: {id: pondId, name: `DO synthetic test ${pondId}`, pondType: "BRACKISH"}});
    const device = await prisma.device.create({data: {id: deviceId, serial: `not-real-${deviceId}`, pondId, assignedAt: new Date(Date.now() - 7 * 86400000)}});
    const createProfile = async (status: "ACTIVE" | "DISABLED") => {
      const id = randomUUID(); profileIds.push(id);
      return prisma.profile.create({data: {id, email: `not-real-${id}@example.invalid`, fullName: "Synthetic DO test", status}});
    };
    return {pond, device, cleanup, createProfile};
  } catch (error) {await cleanup(); throw error;}
}
