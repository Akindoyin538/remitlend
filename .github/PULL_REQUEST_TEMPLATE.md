## Pull Request Checklist

Please ensure your PR follows these steps, mirroring our `CONTRIBUTING.md` guidelines.

- [ ] I have read the `CONTRIBUTING.md` document.
- [ ] My code follows the code style of this project.
- [ ] I have added tests to cover my changes.
- [ ] All new and existing tests passed.
- [ ] I have updated the documentation accordingly.
- [ ] I have verified the changes locally.

## Invariant-Focused Evidence (required for high-risk changes)

CI classifies this PR from its changed paths. If it touches a high-risk area below, link the focused evidence (or a reviewed rationale) and run the exact command CI reports. The gate is currently **report-only** (non-blocking) while it is trialed.

| Risk class | Triggered by changed paths | Minimum evidence | Required command / category |
| --- | --- | --- | --- |
| Money arithmetic | `backend/**/money*`, `backend/**/ledger*`, `backend/**/balance*`, `backend/**/interest*` | Unit + property/fuzz | `npm test -- --testPathPattern="(money|ledger|balance|interest)"` and `npm run test:property` |
| Loan transitions | `backend/**/loan*`, `backend/**/migrations/*loan*` | Integration | `npm run test:integration -- --testPathPattern="loan"` |
| Contract authorization | `contracts/**`, `backend/**/auth*`, `backend/**/permission*` | Unit + E2E | `npm test -- --testPathPattern="(auth|permission)"` and `npm run test:e2e -- --grep "authorization"` |
| Indexing | `backend/**/index*`, `backend/**/search*`, `backend/**/query*` | Integration | `npm run test:integration -- --testPathPattern="(index|search|query)"` |
| Key custody | `backend/**/keys*`, `backend/**/custody*`, `backend/**/sign*`, `backend/**/wallet*` | Unit + property/fuzz | `npm test -- --testPathPattern="(keys|custody|sign|wallet)"` and `npm run test:property` |

- [ ] If CI flagged a risk class above, I have linked the focused test output or added a reviewed rationale explaining why the invariant is not affected.

### Exemptions (narrow)

- **Documentation-only:** changes limited to `*.md`, `docs/**`, or `LICENSE` are exempt.
- **Generated:** changes limited to generated artifacts (e.g. `**/dist/**`, `**/build/**`, `**/*.generated.*`, lockfiles) are exempt.
- Mixed PRs are **not** exempt: any non-doc, non-generated path in a risk class still requires evidence.

Contributors may refine the path patterns or evidence mapping in the CI config, but the required checks themselves cannot be bypassed.
