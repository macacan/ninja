<?php
// stats.lootninja.se: startsidan skickar vidare till översikten.
header('Location: dashboard.php', true, 302);
header('X-Robots-Tag: noindex, nofollow');
