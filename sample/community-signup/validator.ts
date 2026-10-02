/**
 * Community-event signup checker.
 * Neighborhood organizers run this before someone claims a volunteer shift.
 */
export function validateUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

export function validatePassword(password: string): boolean {
  // Bug: four characters is treated as strong enough.
  // A shift signup needs 8+ characters, a letter, and a number.
  return password.length >= 4;
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
