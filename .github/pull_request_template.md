Closes #

## Summary

<!-- What changes and why. -->

## How to test

<!-- Commands and steps. E.g. `orca plugin test . --json`, `.github/scripts/typecheck.sh`,
then a message through the bridge in Orca and Telegram. -->

## Risk

<!-- What can break, for whom (bridged chats, saved settings and tokens, people on the allowlist),
and how to revert. Say what a revert does NOT undo (e.g. messages already sent to Telegram,
settings already migrated, a version already installed from its tag). -->

**Level:** <!-- Low, Medium or High -->

**How to revert:**

## Checklist

- [ ] Tests added or changed
- [ ] `README.md` updated if setup or behavior the user sees changed, or not needed
- [ ] Spec in `specs/` updated if a feature's behavior changed, or not needed
- [ ] `PUBLISHING.md` updated if the release or check steps changed, or not needed
- [ ] Breaking change marked with `!` in the commit (e.g. `feat!:`), or not needed

<!--
The "Doc check" fails when `src/` changes and none of `README.md`, `PUBLISHING.md`, `specs/`
or `docs/` changes. If the change needs no doc, add the `sem-doc` label.
-->
