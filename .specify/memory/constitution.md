# Static Web App Constitution

## Core Principles

### I. Static-Only Delivery

All content must be served as static assets (HTML, CSS, JS, images, fonts). No server-side rendering, databases, or backend code in this project.

### II. Minimal Dependencies

Use the fewest dependencies possible. Prefer plain HTML/CSS/JS. Only add a dependency if it significantly reduces complexity.

### III. Accessibility Basics

Pages must include semantic HTML, a single `<h1>`, and sufficient color contrast. Images must have `alt` text unless decorative.

### IV. Performance Basics

Keep pages lightweight and fast: optimize images, avoid unnecessary scripts, and prefer CSS for visuals.

### V. Simplicity

Keep structure and code straightforward. Avoid premature abstractions and unused features.

## Additional Constraints

- No backend services or server code in this repository.
- All assets must be committed to the repo and referenced with relative paths.
- Pages must work in the latest Chrome, Firefox, and Safari.

## Development Workflow

- Keep changes small and focused.
- Manual verification in a local browser before merging.

## Governance

- This constitution overrides other guidelines for this project.
- Amendments must be documented with rationale and date.

**Version**: 1.0.0 | **Ratified**: 2026-01-31 | **Last Amended**: 2026-01-31
