import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecheckQuestion, recheckItems, unverifiedItems } from "../src/verify.ts";

const CRMS = ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Attio"];

test("re-check questions are recognised; ordinary ones are not", () => {
  assert.ok(isRecheckQuestion("Has any of them changed pricing or shipped something big since?"));
  assert.ok(isRecheckQuestion("Is your answer still correct today?"));
  assert.ok(isRecheckQuestion("Any updates since Monday?"));
  assert.ok(!isRecheckQuestion("What did I ask you on 3 November?"));
  assert.ok(!isRecheckQuestion("Which CRM is best for a small team?"));
});

test("the checklist merges recalled entities without duplicates", () => {
  assert.deepEqual(recheckItems([CRMS, ["hubspot", "Zoho"], undefined]), CRMS);
});

test("the live failure: 5 recalled CRMs, only HubSpot and Pipedrive searched -> 3 flagged", () => {
  const searches = ["HubSpot Sales Hub Pro pricing November 2026", "HubSpot November 2026 product announcement", "Pipedrive Growth plan price 2026"];
  assert.deepEqual(unverifiedItems(CRMS, searches), ["Salesforce", "Zoho CRM", "Attio"]);
});

test("an item counts as searched by its distinctive word, not a generic one", () => {
  assert.deepEqual(unverifiedItems(["Zoho CRM"], ["zoho one price 2026"]), []);
  assert.deepEqual(unverifiedItems(["Zoho CRM"], ["best CRM pricing 2026"]), ["Zoho CRM"]); // "crm" alone isn't Zoho
  assert.deepEqual(unverifiedItems(["AWS RDS"], ["rds postgres pricing"]), []);
});
