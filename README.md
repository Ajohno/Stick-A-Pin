## Donezo

Link: https://donezo-sooty.vercel.app/

Donezo is an application for making and storing a list of task for the user to keep track of. Donezo opens to the user authentication screen where the user is able to either register for an account or log in with an existing username and password. I encountered some issues with the dynamic updating of the task list however I was able to fix the issues. I used the passport local strategy as it seemed the easiest to understand as a first time user. I tried to implement Material Tailwind as I was interested in seeing how it functioned as I have used Tailwind before, however it interfered with my implemented CSS styling and so I was not able to completely implement it.

![Authentication Screen](image-1.png)

![Main Page](image.png)

## Technical Achievements

- **Tech Achievement 1**: I used passport-local to facilitate the user authentication of my application.

- **Tech Achievement 2**: I used MongoDB to facilitate the database for my application. This is where I stored the users' username and password as well as their tasks.

- **Tech Achievement 3**: I created a server using Express.

## Design/Evaluation Achievements

- **Design Achievements**: I followed the following tips from the W3C Web Accessibility Initiative:

- Use headings to convey meaning and structure (This was used in the headings for the forms)

- Provide clear instructions (This was done by using both the labels for the input areas as well as the place holder text to instruct the user on what to do.)

- Provide sufficient contrast between foreground and background

- Ensure that interactive elements are easy to identify (This is done by having interactive styles for the buttons and input areas)

- Ensure that form elements include clearly associated labels

- Provide easily identifiable feedback (This is done by using the alert function in the browser)

- Associate a label with every form control

## Resend Email Verification Setup

The app now sends a verification email after registration and requires a verified email before login.

- Existing accounts are treated as verified by default (legacy-safe), while new registrations are explicitly created as unverified until they verify by email.

1. In Resend, keep your sending domain as `mail.stickapin.app`.
2. Create an API key in Resend.
3. Add these environment variables to your local `.env` and deployment secrets:

```env
RESEND_API_KEY=re_xxxxxxxxx
EMAIL_FROM=Stick A Pin <no-reply@mail.stickapin.app>
APP_BASE_URL=http://localhost:3000  # set to your deployed app URL in production
EMAIL_VERIFICATION_TTL_MINUTES=60
PASSWORD_RESET_TTL_MINUTES=30
```

### What to do with your API key

- Put the key in `RESEND_API_KEY` only (never hardcode it in source files).
- For local development, place it in `.env`.
- For production, set it in your hosting provider's secret/environment settings.


Forgot password flow uses `POST /forgot-password` and `POST /reset-password` with reset links sent through Resend. In production, `APP_BASE_URL` is required so links do not fall back to localhost.
