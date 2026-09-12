# Commit Message Guide

This guide helps you create clear, descriptive commits following best practices.

## Format

```
<type>: <short summary>

- Bullet point of change 1
- Bullet point of change 2
- Bullet point of change 3

[Optional: Additional context paragraph]

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## Types
- **feat:** New feature
- **fix:** Bug fix
- **docs:** Documentation changes
- **style:** UI/CSS changes
- **refactor:** Code restructuring
- **test:** Adding tests
- **chore:** Tooling, dependencies, config

---

# UI Enhancement Commits

Examples of commits for UI improvements.

## Commit 1: Enhance service card visual hierarchy

```bash
git add public/consumer.css
git commit -m "$(cat <<'EOF'
Enhance service card visual hierarchy

- Increase card title font size from 15.5px to 16px
- Improve description readability with larger font (13.5px) and line-height
- Enlarge pricing display to 20px for better prominence
- Add better spacing in pricebox and footer sections
- Improve feature badge padding for better touch targets

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 2: Add smooth hover transitions to service cards

```bash
git add public/ui.css
git commit -m "$(cat <<'EOF'
Add smooth hover transitions to service cards

- Implement lift effect with translateY(-2px) on hover
- Add subtle shadow (shadow-md) for depth perception
- Increase transition duration from 120ms to 200ms for smoother feel
- Apply transitions to border, background, transform, and shadow

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 3: Enhance category filter pill design

```bash
git add public/consumer.css
git commit -m "$(cat <<'EOF'
Enhance category filter pill design with modern interactions

- Add smooth 200ms transitions for all state changes
- Implement lift effect (translateY -1px) on hover
- Add icon scale animation (1.1x) on hover for visual feedback
- Improve hover state with active border color
- Maintain existing accent color for selected state

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 4: Add featured services carousel

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
Add featured services carousel container to marketplace

- Insert mkt-featured div between filters and grid
- Positioned after rfq-panel, before main service grid
- Container will display top-rated services in horizontal scroll

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 5: Implement featured carousel styles

```bash
git add public/consumer.css
git commit -m "$(cat <<'EOF'
Implement featured services carousel styles

- Add horizontal scrolling track with smooth scroll behavior
- Style custom scrollbar (thin, 6px height) with theme colors
- Implement fixed-width cards (320px) with scroll-snap
- Add uppercase header with letter-spacing for modern look
- Configure gap and padding for optimal spacing

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 6: Add carousel logic and rendering

```bash
git add public/user.js
git commit -m "$(cat <<'EOF'
Add featured services carousel logic

- Filter top 3 services with reputation >= 75
- Sort by reputation score in descending order
- Auto-hide carousel when searching or no featured services
- Bind click/keyboard handlers to featured service cards
- Render only when services are loaded and no search active

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 7: Enhance search input interactions

```bash
git add public/consumer.css
git commit -m "$(cat <<'EOF'
Enhance search input with focus and hover states

- Add border color transition on hover (200ms)
- Implement focus state with subtle accent shadow (3px)
- Use accent-subtle color for non-intrusive focus ring
- Apply smooth transitions for better user feedback

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 8: Add trust badge hover animation

```bash
git add public/consumer.css
git commit -m "$(cat <<'EOF'
Add trust badge hover animation

- Implement scale transform (1.05x) on hover
- Add 200ms transition for smooth scaling
- Increase padding from 3px 9px to 4px 10px
- Enhance visual feedback for interactive badges

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 9: Improve button transitions globally

```bash
git add public/ui.css
git commit -m "$(cat <<'EOF'
Improve button transitions globally

- Increase transition duration from 120ms to 200ms
- Apply to all interactive elements (buttons, pills, tabs)
- Add smooth shadow transition on primary button hover
- Implement subtle lift with accent shadow on hover
- Maintain consistent easing curve across all transitions

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Commit 10: Polish service card typography

```bash
git add public/consumer.css
git commit -m "$(cat <<'EOF'
Polish service card typography and spacing

- Improve description line-height (1.5) for readability
- Enhance price subtitle sizing (13px) and spacing
- Adjust pricebox padding-top from 10px to 12px
- Fine-tune footer margin-top for visual balance
- Increase feature badge padding for better proportion

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Complete Workflow (All at Once)

If you prefer to commit everything together:

```bash
git add public/consumer.css public/ui.css public/user.js public/index.html
git commit -m "$(cat <<'EOF'
Enhance marketplace UI with modern interactions

Service Cards:
- Improve visual hierarchy with larger typography
- Add smooth hover effects (lift + shadow)
- Enhance trust badges with scale animation

Featured Carousel:
- Add horizontal scrolling showcase for top services
- Implement custom scrollbar styling
- Auto-hide when searching

Category Filters:
- Add smooth transitions and lift effects
- Implement icon scale animation on hover
- Improve active state feedback

Search & Interactions:
- Enhance focus states with subtle accent shadows
- Improve button transitions globally (200ms)
- Add consistent easing across all animations

All changes maintain existing Functor design system
and color palette while adding modern polish.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Tips

1. **Check status before each commit:**
   ```bash
   git status
   git diff public/consumer.css  # review changes
   ```

2. **Stage specific line ranges (if needed):**
   ```bash
   git add -p public/consumer.css  # interactive staging
   ```

3. **View commit history:**
   ```bash
   git log --oneline
   ```

4. **Amend last commit (if needed):**
   ```bash
   git commit --amend --no-edit
   ```

5. **Create feature branch (recommended):**
   ```bash
   git checkout -b feature/ui-enhancements
   # Make commits
   git checkout main
   git merge feature/ui-enhancements
   ```

---

## Verification

After committing, verify your changes:

```bash
# View all commits
git log --oneline -10

# View specific commit
git show <commit-hash>

# View changes in a file across commits
git log -p public/consumer.css
```

---

# Integration & Tooling Commits

Examples of commits for integrations, testing, and tooling.

## Example 1: ChatGPT Integration

```bash
git add package.json package-lock.json test-chatgpt.mjs openapi-ngrok.json COMMIT_GUIDE.md .gitignore
git commit -m "$(cat <<'EOF'
Add ChatGPT integration and testing infrastructure

- Add OpenAI SDK dependency for ChatGPT function calling tests
- Create test-chatgpt.mjs for testing MeterX402 connector with ChatGPT API
- Generate openapi-ngrok.json with public HTTPS URL for Custom GPT setup
- Add COMMIT_GUIDE.md with standardized commit message format
- Update .gitignore to exclude ngrok binaries and archives

This enables testing the universal connector with ChatGPT through both
the API (function calling) and Custom GPT UI (via ngrok tunnel).

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Example 2: Universal Connector Package

```bash
git add packages/universal-connector/
git commit -m "$(cat <<'EOF'
Create universal connector package for cross-LLM integration

- Implement REST API server with Hono framework
- Generate OpenAPI 3.1 spec for all LLM platforms
- Add endpoints: /services, /call, /openapi.json
- Support Claude, ChatGPT, Gemini, Grok, Perplexity
- Create comprehensive README with setup guides

Provides single connector that works with all major LLMs instead of
building separate plugins for each platform.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Example 3: Dependency Updates

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
Upgrade dependencies to latest versions

- Update @x402/core from 2.24.0 to 2.25.0
- Update @hiero-ledger/sdk from 2.84.0 to 2.85.0
- Update hono from 4.13.5 to 4.13.7
- Fix peer dependency warnings with @reown/appkit

Addresses security vulnerabilities and improves performance.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

## Example 4: Testing Infrastructure

```bash
git add test/ jest.config.js package.json
git commit -m "$(cat <<'EOF'
Add unit testing infrastructure with Jest

- Configure Jest for TypeScript and ESM
- Create test suite for MeterX402 SDK methods
- Add tests for service discovery and payment flows
- Implement mock Hedera client for isolated testing
- Add npm test script and coverage reporting

Enables automated testing and CI/CD integration.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Quick Reference

### Common Patterns

**New Feature:**
```bash
git commit -m "Add [feature name]

- Implementation detail 1
- Implementation detail 2

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Bug Fix:**
```bash
git commit -m "Fix [issue description]

- Root cause explanation
- Solution implemented

Fixes #123

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Refactoring:**
```bash
git commit -m "Refactor [component/module] for [benefit]

- Change 1
- Change 2
- No functional changes

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```
