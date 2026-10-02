import {
  validateEmail,
  validatePassword,
  validateUsername,
} from "./validator";

export function checkUsername(): void {
  if (validateUsername("ada_lovelace") !== true) {
    throw new Error("ada_lovelace should be accepted");
  }
  if (validateUsername("ab") !== false) {
    throw new Error("two-character usernames should be rejected");
  }
  if (validateUsername("has space") !== false) {
    throw new Error("usernames with spaces should be rejected");
  }
}

export function checkPassword(): void {
  if (validatePassword("sunset12") !== true) {
    throw new Error("sunset12 should be accepted");
  }
  if (validatePassword("short") !== false) {
    throw new Error("short should be rejected");
  }
  if (validatePassword("longpassword") !== false) {
    throw new Error("longpassword should be rejected because it has no number");
  }
}

export function checkEmail(): void {
  if (validateEmail("ada@community.org") !== true) {
    throw new Error("ada@community.org should be accepted");
  }
  if (validateEmail("not-an-email") !== false) {
    throw new Error("not-an-email should be rejected");
  }
}
