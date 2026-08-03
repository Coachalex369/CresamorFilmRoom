# CLAUDE.md

# Cresamor

**Version:** MVP
**Last Updated:** August 2026

---

# Project Overview

Cresamor is an athlete-centered sports platform designed around film, communication, and long-term athlete development.

Unlike Hudl, Cresamor is designed around the athlete rather than only the coach.

Core philosophy:

> Every athlete deserves a permanent archive of their athletic journey.

The MVP focuses on film because film is the highest value feature for coaches while naturally leading athletes and parents into the platform.

---

# Current MVP Priorities

Current order of importance:

1. Authentication
2. Film Upload
3. Film Playback
4. Athlete Profiles
5. Messaging
6. Team Calendar
7. Parent Accounts

Everything else is secondary.

---

# Design Philosophy

The application should always feel:

- fast
- modern
- simple
- mobile-first

Avoid clutter.

Every screen should answer one question:

"What does this user need next?"

Never build complicated admin panels unless absolutely necessary.

---

# User Types

Current users:

## Coach

Paid account.

Responsibilities:

- upload film
- organize teams
- send messages
- create events
- manage athletes

---

## Athlete

Free account.

Responsibilities:

- watch film
- create highlights
- build profile
- communicate

---

## Parent

Free account.

Responsibilities:

- follow athletes
- watch approved film
- receive communication
- calendar access

Parent accounts will eventually connect through invitation codes.

---

# Navigation

Current navigation:

Home

Film

Calendar

Messages

Profile

Settings

Future:

Recruiting

Teams

Organization

---

# Home Screen

The Home screen is the application's dashboard.

Sections:

- Hero Card
- Featured Highlights
- Continue Watching
- Messages Preview
- Upcoming Events
- Activity Feed

The Home screen should never become cluttered.

---

# Film Philosophy

Film is the core of Cresamor.

Everything should make watching, creating and sharing film easier.

Current features:

- upload
- playback
- timeline
- markers
- drawing
- notes
- fullscreen
- saved highlights

Future:

- live capture
- sideline replay
- automatic compression
- streaming
- playlists
- recruiting reels

---

# Athlete Profile Philosophy

Athlete profiles are intended to become a digital sports resume.

Current:

- bio
- accomplishments
- goals
- profile picture

Future:

- stats
- measurements
- verified testing
- awards
- recruiting links
- social links
- academic achievements

Profile edits must always be stored in PostgreSQL.

Never rely on browser storage.

---

# Messaging

Messaging should eventually function similarly to modern team chats.

Current MVP:

- conversations
- text messages

Future:

- reactions
- media
- read receipts
- announcements
- coach-only channels

Messages belong in PostgreSQL.

Never in localStorage.

---

# Video Storage

Current:

Uploads stored on server.

Future architecture:

Client

↓

Upload

↓

Object Storage

↓

Video Processing Queue

↓

Compressed Video

↓

Thumbnail

↓

Playback

Render local storage is temporary.

Long-term storage should use cloud object storage.

---

# Video Processing

Future upload pipeline:

Validate

↓

Upload

↓

Compression

↓

Thumbnail Generation

↓

Streaming Version

↓

Ready

Do not tightly couple uploads with transcoding.

The processing system should remain modular.

---

# Mobile Philosophy

Mobile is the primary platform.

Desktop is secondary.

Any feature should feel natural on a phone before desktop improvements.

---

# UI Style

Theme:

Dark

Gold accents

Minimal shadows

Rounded cards

Large touch targets

Simple typography

Avoid tiny buttons.

---

# Database Philosophy

Source of truth:

PostgreSQL

Never store persistent application data inside:

- localStorage
- sessionStorage
- mockData.js

Mock data should only exist during development.

---

# API Philosophy

REST style endpoints.

Examples:

GET

POST

PUT

DELETE

Keep endpoints organized by resource.

Good:

/api/profile

/api/videos

/api/messages

Avoid action-based endpoints when possible.

---

# Code Philosophy

Prefer:

Small modules

Reusable utilities

Simple functions

Readable code

Avoid:

Massive files

Repeated code

Nested conditionals

Hidden side effects

If something exceeds roughly 300–400 lines, consider splitting it.

---

# Performance Goals

Video playback should feel instant.

Images should load immediately.

Film uploads should display:

- progress
- percentage
- estimated remaining time

Never leave users wondering whether something is happening.

---

# Future Roadmap

Phase 1

✔ Authentication

✔ Film Upload

✔ Playback

✔ Home Screen

⬜ Profiles

⬜ Messaging

⬜ Calendar

Phase 2

- Mobile Capture
- Parent Accounts
- Team Management
- Notifications
- Film Compression

Phase 3

- Recruiting
- Statistics
- AI Search
- Clip Sharing
- Playlists

Phase 4

- Organization Dashboard
- Multi-school Support
- League Management
- Analytics

---

# Rules For Future Development

When modifying Cresamor:

DO

- preserve current architecture
- reuse components
- favor modular code
- document new endpoints
- update this file when architecture changes

DO NOT

- duplicate functionality
- introduce parallel systems
- redesign working interfaces without reason
- store persistent data locally
- break mobile responsiveness

---

# Definition of Done

A feature is complete when:

✓ Works on desktop

✓ Works on mobile

✓ Persists after refresh

✓ Persists across devices

✓ Handles errors gracefully

✓ Includes loading states

✓ Matches Cresamor styling

✓ Does not break existing features