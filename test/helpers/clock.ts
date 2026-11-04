/** A time zone where it is about `hour` o'clock right now, so a test that
 * depends on quiet hours (9pm to 8am in the coach's zone) behaves the same
 * whenever it runs. Etc/GMT signs are the other way round: Etc/GMT-3 is
 * three hours ahead of UTC. */
export function zoneAt(hour: number, now = new Date()): string {
  let offset = hour - now.getUTCHours();
  if (offset > 12) offset -= 24;
  if (offset < -11) offset += 24;
  return offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}
