30-Second Elevator Pitch
Cresamor Film Room is a sports video platform designed for teams where coaches upload game film, and athletes and parents can view, clip, and save highlights directly to athlete profiles.
Unlike existing tools that focus heavily on analytics, Cresamor focuses on athlete experience and accessibility, allowing players to easily create and revisit their best moments.
Tagline: Your Film, Your Way.

MVP Core Features (Concrete & Implementable)
Authentication & Roles
•	Users can register and log in 
•	Users have roles: coach, athlete, parent 
•	Coaches upload film
•	Players and parents see notes and can clip highlights 

Stretch Goal Features
These are NOT required for MVP, but show ambition:
•	Drawing tools on video 
•	Frame-by-frame playback controls 
•	Messaging system 
•	Team schedule/calendar 
•	Public athlete profiles (shareable links) 
•	Coach feedback on clips 
•	Highlight export/download 
•	Video tagging system
•	Live stream events
Project Management System & Development Workflow
This project will be managed using GitHub Projects (Kanban board) to organize development and track progress. The board will include the following columns:
•	Backlog – All planned tasks and features not yet started 
•	In Progress – Tasks currently being worked on 
•	Review – Completed tasks that are being tested or refined 
•	Done – Fully completed and verified tasks 

Development Phases
Because this is a solo project, development will be divided into structured phases to maintain focus and prevent scope creep:
1.	Backend Foundation 
o	Set up Express server 
o	Set up PostgreSQL database 
o	Implement authentication (JWT) 
o	Create all database models 
o	Build API routes: 
	users 
	teams 
	videos 
	clips 
	snapshots 
	notes 
2.	Frontend Structure 
o	Set up React app (Vite) 
o	Build routing system 
o	Create authentication UI (login/register) 
o	Build core pages: 
	Dashboard 
	Film Room (video page) 
	Profile page 
	Team page 
3.	Core Features 
o	Video upload functionality 
o	Video player 
o	Clip creation system 
o	Snapshot capture 
o	Profile rendering 
4.	Polish & Testing 
o	UI improvements 
o	Bug fixes 
o	Performance adjustments 
o	Final testing

Ticket Strategy
Each task will be broken down into small, focused tickets that can be completed independently.
•	Tickets will move through the Kanban board:
Backlog → In Progress → Review → Done 
•	Each ticket will be: 
o	Clearly defined 
o	Completed before starting new work 
o	Tested before being marked as done

