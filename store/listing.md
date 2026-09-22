# Chrome Web Store listing

Copy for each field of the developer dashboard. The images in this folder come from
`node store/render.mjs`.

## Store listing

**Summary** comes from the manifest's `description` (132 characters at most) and can't be edited in
the dashboard.

**Description**

```
MapLiberator saves your whole outdoor mapping account to one ZIP file on your computer: every track, route, waypoint, area and photo, and the folders you keep them in.

Works with Gaia GPS, AllTrails and Strava.

WHAT'S IN THE ARCHIVE
• Tracks and routes as GPX, with their names, descriptions, dates and stats
• Waypoints and areas as GeoJSON
• Your photos as the original files, with captions, dates and locations
• Your folders and lists, so you can see how everything was organized
• A list of anything that couldn't be exported, and why

Unzip it and drag a track into any other map app. The archive follows the Portable Map Archive format, an open specification any app can import: https://mapliberator.com/spec/

PRIVATE BY DESIGN
MapLiberator runs in your browser, signed in as you. It talks only to the service you're exporting from and saves the file straight to your computer. There's no MapLiberator account, no server, no analytics and no tracking. It asks for access to a service's website only when you choose to export from it.

Free and open source under the MIT license: https://github.com/mapliberator/extension

MapLiberator is not affiliated with Gaia GPS, AllTrails or Strava.
```

**Category:** Productivity › Tools

**Language:** English

**Store icon:** `icon-128.png`

**Screenshots:** at least one 1280×800 capture of the export page (still to take).

**Small promo tile:** `promo-small-440x280.png`

**Marquee promo tile:** `promo-marquee-1400x560.png`

**Homepage URL:** https://mapliberator.com/

**Support URL:** https://github.com/mapliberator/extension/issues

**Mature content:** No

## Privacy practices

**Single purpose**

```
MapLiberator exports a person's own data from an outdoor mapping service (Gaia GPS, AllTrails or Strava) into a single ZIP archive saved on their computer.
```

**activeTab justification**

```
When the user clicks the toolbar button, the popup reads the URL of the current tab to check whether it is one of the supported mapping services, so it can offer to export from that service directly. The URL is not stored or sent anywhere.
```

**scripting justification**

```
To read the user's data, MapLiberator opens a background tab on the mapping service's own site (for example www.gaiagps.com) and injects its bundled script there, so requests to the service's API use the session the user is already signed in with. The script refuses to run on any other site and only sends requests to that one origin. It only reads data: it never changes anything in the user's account, and it never reads cookies, passwords or tokens.
```

**downloads justification**

```
In browsers that can't write a file directly with the File System Access API, the finished archive is saved to the user's computer through the downloads API, and the "Show in folder" button uses it to reveal the saved file.
```

**unlimitedStorage justification**

```
In browsers that can't write a file directly, the archive is built in the extension's own private storage (the origin private file system) before it is saved. An account with photos can run to several gigabytes, more than the default quota allows. The staged file is deleted as soon as the download completes, or when the export is cancelled or fails.
```

**Host permission justification**

```
Host access is optional and requested for one service at a time, only when the user starts an export from it: www.gaiagps.com and photos.gaiagps.xyz for Gaia GPS, www.alltrails.com and images.alltrails.com for AllTrails, www.strava.com and dgtzuqphqg23d.cloudfront.net for Strava. The first host of each pair serves the user's data and the second serves their photos. The extension makes no requests to any other host.
```

**Remote code:** No, I am not using remote code.

**Data usage.** Chrome asks for this even when data never leaves the device. Tick:

| Type                              | Tick | Why                                                                  |
| --------------------------------- | ---- | -------------------------------------------------------------------- |
| Personally identifiable info      | Yes  | The account's display name and ID are recorded in the archive        |
| Health information                | Yes  | Strava's activity GPX files carry heart rate when it was recorded    |
| Financial and payment information | No   |                                                                      |
| Authentication information        | No   | The browser attaches the session; the extension never reads it       |
| Personal communications           | No   |                                                                      |
| Location                          | Yes  | GPS tracks, routes, waypoints, areas and photo locations             |
| Web history                       | No   | The active tab's URL is only compared against the supported services |
| User activity                     | No   |                                                                      |
| Website content                   | Yes  | Photos, names, descriptions and notes from the user's account        |

Tick all three certifications (no selling or transferring data, no use unrelated to the single
purpose, no creditworthiness or lending).

**Privacy policy URL:** https://mapliberator.com/privacy/
