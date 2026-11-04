# Scrylair

A Chrome extension that adds [Scryfall](https://scryfall.com) prices to the card list on [Secret Lair](https://secretlair.wizards.com) product pages.

For each card it shows:

- the cheapest non-foil and foil price across all paper printings (`$0.43 / 🌠 $0.53`)
- the price of the drop's own Secret Lair printing (`· SL $25.75`)
- a total for the whole drop under the list

Every price links to that printing on Scryfall. Bundle pages are skipped.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.

## Options

Click the toolbar icon to:

- exclude Universes Beyond printings
- show or hide USD and EUR
- clear the price cache

## Notes

- Prices are cached for 24 hours, since Scryfall updates them once a day.
- Requests are spaced to respect [Scryfall's rate limits](https://scryfall.com/docs/api/rate-limits), so the first visit to a drop takes a few seconds.
- Debug output goes to the extension's service worker console (`chrome://extensions` → Scrylair → *service worker*). Messages are prefixed with `[scrylair]`.
- Not affiliated with Wizards of the Coast or Scryfall.
