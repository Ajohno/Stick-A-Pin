# Security TODOs before/after public beta

- Replace inline `style` attributes and inline event handlers in public HTML with classes/listeners, then remove the temporary CSP `unsafe-inline` allowances for scripts/styles.
- Rotate any credentials that ever appeared in git history before making the repository public, even though current committed files no longer contain real secret values.
- Add automated integration tests for CSRF failures, authenticated route rate limits, oversized request payloads, and OAuth callback origin behavior.
- Review production logs periodically to ensure webhook, feedback, and authentication errors do not include sensitive user data or provider secrets.
