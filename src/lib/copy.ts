export function spotsWord(n: number): string {
  return `${n} ${n === 1 ? 'spot' : 'spots'}`;
}

export function athletesLabel(n: number): string {
  return `${n} ${n === 1 ? 'athlete' : 'athletes'}`;
}

export function spotsBookedLabel(booked: number, capacity: number, holding = 0): string {
  let s = `${booked} of ${spotsWord(capacity)} booked`;
  if (holding > 0) s += ` · ${holding} holding`;
  return s;
}