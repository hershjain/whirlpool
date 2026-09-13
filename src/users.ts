import { prisma } from "./db.js";

// Created by the first inbound text from a number. That message is the
// sign-up and the opt-in at once, which is why its SID is recorded: for A2P
// registration you have to be able to show how consent was collected, and
// "they texted us first, here is the message" is the cleanest form of it.
//
// Returns whether this call created the user, so the caller can send the
// one-time welcome without a second query.
export async function upsertUserOnInbound(
  phone: string,
  messageSid: string,
): Promise<{ created: boolean }> {
  const existing = await prisma.user.findUnique({ where: { phone } });

  if (existing) {
    await prisma.user.update({
      where: { phone },
      data: {
        lastSeenAt: new Date(),
        // Texting again after a STOP is an opt back in. Twilio already treats
        // any inbound message as clearing its own block, so not mirroring
        // that here would leave us refusing to send to someone the carrier is
        // perfectly willing to deliver to.
        optedOutAt: null,
      },
    });
    return { created: false };
  }

  await prisma.user.create({
    data: { phone, optInMessageSid: messageSid },
  });
  return { created: true };
}

export async function setOptedOut(phone: string, optedOut: boolean): Promise<void> {
  await prisma.user.updateMany({
    where: { phone },
    data: { optedOutAt: optedOut ? new Date() : null },
  });
}

// Seeds User rows for numbers that were saving items before this table
// existed - in practice the single owner the app used to be hardcoded to.
// Idempotent, and runs at startup so an existing install does not have to be
// migrated by hand before anyone can log in.
export async function backfillUsersFromItems(): Promise<number> {
  const [itemPhones, folderPhones] = await Promise.all([
    prisma.item.findMany({ distinct: ["phone"], select: { phone: true } }),
    prisma.folder.findMany({ distinct: ["phone"], select: { phone: true } }),
  ]);

  const phones = new Set([...itemPhones, ...folderPhones].map((row) => row.phone));
  if (phones.size === 0) return 0;

  const existing = await prisma.user.findMany({
    where: { phone: { in: [...phones] } },
    select: { phone: true },
  });
  for (const user of existing) phones.delete(user.phone);

  if (phones.size === 0) return 0;

  await prisma.user.createMany({
    data: [...phones].map((phone) => ({ phone })),
  });
  return phones.size;
}
