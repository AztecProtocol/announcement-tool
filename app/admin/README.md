# Admin UI

The admin interface lets authorized publishers compose, review, and publish announcements.

## Compose Flow

1. Open `/admin`.
2. Fill the announcement form: title, body, target networks, audiences, severity, action items.
3. Select Discord roles to notify (if applicable).
4. Click **Save Draft** — the browser stores the form state in a URL-parameterized route.
5. From the drafts list, click **Review** to move to the review page.

## Review and Publish

The review page shows the stored announcement in two views — **Rendered** (formatted) and **Raw** (JSON). You can see how each target channel will receive the announcement.

### What the review page shows

The review page renders the exact payload each channel will receive, in the same "Rendered" and "Raw" views as the compose page. The payload is built from the stored announcement, so the slug in every canonical link and the `event_id` in the webhook JSON are the ones that will actually be sent.

`published_at` is the one field the preview cannot know: the publishing transaction sets it. It shows as `null`.

**Before you confirm a critical announcement, check the Discord tab in Raw view.** The banner above the preview names every role the post will notify. Discord role mentions are the one part of an announcement that cannot be withdrawn after it is sent — a withdrawal stops future delivery, it does not un-ping anyone.

## Publish

1. From the review page, click **Request Publication**.
2. The announcement enters a queue visible to all publishers.
3. Another authorized publisher opens the same announcement (via the queue or review URL) and clicks **Confirm**.
4. The transaction publishes the announcement and enqueues all outbound deliveries.

Once published, you can still withdraw the announcement to stop future deliveries (scheduled or retried). A withdrawal does not recall messages already sent.
