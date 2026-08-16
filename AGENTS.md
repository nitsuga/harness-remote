# OpenCode 2 Validation

- For OpenCode 2 API work, validate behavior against the live V2 endpoint first: `https://opencode2.eric-schneider.net:443`. Credentials can be found in `/home/eric/.config/opencode/local_test_credentials.txt`
- Use the local OpenCode checkout at `~/workspaces/opencode` on its `beta` branch as a secondary source reference when diagnosing or explaining the live behavior.
- Never commit, echo, or add endpoint credentials to repository files, prompts, logs, or test fixtures.
- Prefer read-only live API checks. Before a live mutation, ensure it cannot trigger a model call; use disposable state and clean it up when appropriate.

# Fork Policy

- Work only in this fork, `nitsuga/harness-remote`.
- Never open, post, or comment on issues or PRs in the upstream repository `giuliastro/harness-remote`.
- Track and deliver all work (issues, PRs, merges) in this fork only.
