import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Read wiring without importing routes: their dependencies read production secrets at import time.
function source(file: string) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

for (const [resource, registry] of [["ponds", "pondRegistry"], ["devices", "deviceRegistry"]]) {
  test(`${resource} registry mutations are mounted behind active-account authentication`, () => {
    const router = source(`routes/${resource}.ts`);
    const auth = router.indexOf(`${resource}Router.use(requireAuth);`);
    const mount = router.indexOf(`${resource}Router.use(${registry}Router);`);
    assert.ok(auth >= 0 && mount > auth, "authentication must precede registry mutations");
    assert.ok(router.includes(`import { ${registry}Router } from "./${registry}.ts";`));
    assert.doesNotMatch(router, /requireAdmin/);
    const mutations = source(`routes/${registry}.ts`);
    assert.doesNotMatch(mutations, /requireAdmin|systemRole/);
    assert.ok(mutations.includes(`${registry}Router.post("/", validate(`));
    assert.ok(mutations.includes(`${registry}Router.patch(`));
    if (resource === "devices") {
      assert.ok(mutations.includes('deviceRegistryRouter.post("/:id/rotate-secret", rotateSecretRateLimit, validate('));
    }
    const entry = source("index.ts");
    assert.ok(entry.includes(`app.use("/${resource}", ${resource}Router);`));
  });
}

test("user administration and audit retain the admin guard without registry mounts", () => {
  const admin = source("routes/admin.ts");
  const guard = admin.indexOf("adminRouter.use(requireAuth, requireAdmin);");
  assert.ok(guard >= 0);
  for (const route of ['adminRouter.post("/users"', 'adminRouter.get("/audit"']) {
    assert.ok(admin.indexOf(route) > guard, `${route} must follow the admin guard`);
  }
  assert.doesNotMatch(admin, /adminRouter\.use\("\/(ponds|devices)"/);
});
