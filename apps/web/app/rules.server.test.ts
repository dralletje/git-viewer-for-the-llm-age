import { test } from "node:test";
import assert from "node:assert/strict";
import { ignoreRules, ignoredBy, parseIgnoreRules } from "#/rules.server.ts";

test("sets aside mimas's tests and stories, and nothing else", () => {
  const cases: Array<[string, string | null]> = [
    ["apps/mimas-server/src/domain/billing/__tests__/checkout.test.ts", "tests"],
    ["apps/patient-app/app/routes/payment/__tests__/route.test.ts", "tests"],
    ["packages/hydra/src/session.spec.ts", "tests"],
    ["apps/clinician-portal/src/lib/auth.test.tsx", "tests"],
    ["e2e/patient-app/payment.spec.ts", "tests"],
    ["e2e/playwright.config.ts", "tests"],
    ["apps/mimas-server/src/test-support/e2e/fake-hydra.ts", "tests"],
    ["apps/mimas-server/src/test-setup.ts", "tests"],
    ["apps/patient-portal/vitest.config.ts", "tests"],
    ["apps/mimas-server/tests/login-phone.ts", "tests"],
    ["tests/helpers/database.ts", "tests"],
    ["packages/hydra/test/fixtures.ts", "tests"],
    ["packages/limbic-ui/src/button/Button.stories.tsx", "stories"],
    ["apps/patient-portal/.storybook/preview.tsx", "stories"],
    ["apps/patient-portal/src/pages/medicare/__stories__/check-fixtures.ts", "stories"],
    ["apps/patient-portal/src/story-support/story-router.tsx", "stories"],
    ["packages/limbic-ui/src/storybook/index.ts", "stories"],
    ["apps/patient-portal/tsconfig.storybook.json", "stories"],
    ["apps/patient-app/app/routes/payment/route.tsx", null],
    ["apps/mimas-server/src/domain/billing/checkout.ts", null],
    ["docs/storybook.md", null],
    ["apps/clinician-portal/src/latest-tests-page.tsx", null],
    ["apps/clinician-portal/src/tests-overview/page.tsx", null],
  ];
  assert.deepEqual(
    cases.map(([path]) => [path, ignoredBy([path], ignoreRules)]),
    cases,
  );
});

test("a file renamed into or out of a test folder counts", () => {
  assert.equal(ignoredBy(["src/helpers.ts", "src/__tests__/helpers.ts"], ignoreRules), "tests");
});

test("a .room.toml adds its own rules, after tests and stories", () => {
  const own = parseIgnoreRules(`
[[ignore]]
name = "generated"
files = ["**/generated/**", "**/*.gen.ts"]

[[ignore]]
files = ["docs/**"]
`);
  assert.deepEqual(own.problems, []);
  const rules = [...ignoreRules, ...own.rules];
  assert.deepEqual(
    ["packages/api/src/generated/client.ts", "src/schema.gen.ts", "docs/setup.md", "src/generated/client.test.ts", "src/app.ts"].map((path) => ignoredBy([path], rules)),
    ["generated", "generated", "set aside", "tests", null],
  );
});

test("a .room.toml's broken rules are named, the rest kept", () => {
  const own = parseIgnoreRules(`
[[ignore]]
name = "generated"
files = "**/generated/**"

[[ignore]]
name = "vendored"
files = ["vendor/**"]
`);
  assert.deepEqual(own.rules, [{ name: "vendored", patterns: ["vendor/**"] }]);
  assert.deepEqual(own.problems, ['Ignore rule "generated": files is a list of globs.']);
  assert.deepEqual(parseIgnoreRules("[[ignore]\n").rules, []);
});
