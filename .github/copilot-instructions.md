# Copilot PR Review Instructions

When reviewing pull requests, please prioritize the following:

## ✅ Correctness
- Check that reward calculations and Redux logic are accurate.
- Validate that all budget and fraud prevention constraints are enforced.
- Detect any hardcoded values that should be dynamic or environment-based.

## 🧪 Test Coverage
- Ensure unit and integration tests cover all critical paths.
- Flag PRs with incomplete or missing test cases for core logic.

## 🔐 Security
- Identify any insecure uses of user input, especially in reward flows.
- Warn if sensitive logic lacks adequate protection (e.g. PIN, limits).

## 💡 Design Suggestions
- Recommend cleaner abstractions for deeply nested state.
- Highlight any overly complex conditionals or duplicated logic.

## 🚨 Red Flags
- Missing fields in PR template (especially success metrics or testing checklist)
- PRs that introduce breaking changes without clear deployment notes

---

Follow these principles to help us ship safer, faster, and more resilient code.
