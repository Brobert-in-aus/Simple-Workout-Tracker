# Workout Tracker Color Palette

This document defines the official color palette for the Workout Tracker application. **Only these colors should be used** for custom styling and branding elements.

## Official Color Palette

| Color Name | Hex Code | RGB | Usage |
|-----------|----------|-----|-------|
| Light Blue (Primary) | `#eef2ff` | rgb(238, 242, 255) | Primary backgrounds, set type selector backgrounds |
| White | `#ffffff` | rgb(255, 255, 255) | Cards, elevated surfaces, high-contrast neutral backgrounds |
| Medium Blue | `#d6daf0` | rgb(214, 218, 240) | Secondary backgrounds, borders |
| Cool Grey Blue | `#b7c5d9` | rgb(183, 197, 217) | Tertiary backgrounds, subtle accents |
| Dark Blue (Headers) | `#0f0c5d` | rgb(15, 12, 93) | Primary text, headers, net weight text |
| Green (Accent) | `#117743` | rgb(17, 119, 67) | Success states, "Workout In Progress" banner |
| Cream Yellow | `#feffee` | rgb(254, 255, 238) | Warmup badge backgrounds |
| Warm Beige | `#ede0d6` | rgb(237, 224, 214) | Neutral backgrounds |
| Olive Green | `#7a983a` | rgb(122, 152, 58) | Secondary accent |
| Dark Red | `#6a0005` | rgb(106, 0, 5) | Warmup badge text, error states |
| Deep Purple | `#190080` | rgb(25, 0, 128) | Dark accent, emphasis |

## Implementation Guidelines

### Tailwind CSS
For Tailwind utility classes, use the closest matching built-in color when possible. For exact color matches, use inline styles:

```jsx
// Exact custom color
<div style={{ color: '#0f0c5d' }}>Dark Blue Text</div>
<div style={{ backgroundColor: '#eef2ff' }}>Light Blue Background</div>

// Close Tailwind approximations
className="bg-blue-50"     // Close to #eef2ff
className="text-gray-700"   // For general text (not custom colors)
```

### CSS Custom Properties
The palette can also be defined as CSS custom properties in your main stylesheet:

```css
:root {
  --color-primary-light: #eef2ff;
  --color-white: #ffffff;
  --color-primary-medium: #d6daf0;
  --color-grey-blue: #b7c5d9;
  --color-dark-blue: #0f0c5d;
  --color-accent-green: #117743;
  --color-warmup-bg: #feffee;
  --color-beige: #ede0d6;
  --color-olive: #7a983a;
  --color-dark-red: #6a0005;
  --color-deep-purple: #190080;
}
```

## Current Usage Examples

### Net Weight Display
- **Text Color:** `#0f0c5d` (Dark Blue)
- **Background:** `bg-gray-100` (light grey)

### Set Type Selector
- **Background:** `#eef2ff` (Light Blue)

### Workout In Progress Banner
- **Background:** `#117743` (Green)
- **Text:** White

### Warmup Badge
- **Background:** `#feffee` (Cream Yellow)
- **Text:** `#6a0005` (Dark Red)

## Notes

- Always maintain sufficient contrast ratios for accessibility (WCAG AA standard: 4.5:1 for normal text)
- When in doubt, use the Tailwind default theme colors for general UI elements
- Reserve the custom palette colors for branding and specific application features
- Test colors in both light and potential dark mode implementations
