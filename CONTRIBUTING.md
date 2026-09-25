# Contributing

## Local checks

```bash
npm install
npm run typecheck
npm test
npm run synth -- -c stage=test -c defaultModelId=dummy-model
```

## Change rules

- Keep tenant behavior configurable when possible.
- Never make a prompt the only enforcement for authentication or authorization.
- Do not add unofficial WhatsApp Web protocol libraries.
- Never commit real customer secrets or phone numbers.
- New built-in tools need unit tests for their policy/security behavior.
- Keep Lambda handlers thin; domain behavior belongs in `core`, `tools`, `providers` or `storage`.

## Pull requests

Describe:

1. the user/business problem;
2. architecture impact;
3. security impact;
4. migration/config changes;
5. test evidence.
