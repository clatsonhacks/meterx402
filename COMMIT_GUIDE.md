# UI Enhancement Commit Guide

This guide helps you commit the UI improvements in logical, atomic commits.

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
