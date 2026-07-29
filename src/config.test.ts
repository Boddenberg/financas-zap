import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigError,
  normalizeInternationalPhone,
} from "./config";

test("acrescenta o código do Brasil aos dois formatos locais configurados", () => {
  assert.equal(normalizeInternationalPhone("11 98109-0986"), "5511981090986");
  assert.equal(normalizeInternationalPhone("11972435718"), "5511972435718");
});

test("preserva um número que já está no formato internacional", () => {
  assert.equal(normalizeInternationalPhone("+55 11 98109-0986"), "5511981090986");
});

test("recusa números incompletos", () => {
  assert.throws(
    () => normalizeInternationalPhone("1234"),
    (error) => error instanceof ConfigError,
  );
});
