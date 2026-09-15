# Instruction

1. Do not commit or push. Let me do those.
2. If there's only one agent working on the repo then use this checkout to make changes instead of a separate worktree
3. I'll keep some of our chat history in folder "ai" that you can reference back to.

Prompts and plans are numbered and paired in ai/ (prompt_0.md -> plan_0.md -> next_0.md). Write a new plan next to the prompt it answers.
- next_0.md is a summary of the implementation and what to work on next as decided by Claude. 


# Spec

1. The web app needs to load in 2~3 sec on current average internet speed
    1. This is initial load, i.e., time to user interaction. Progressive load later is fine
    2. 1 sec will be great
    3. 4 sec is absolute maximum
2. The app needs to render and play well
    1. on an average PC bought within 3 years, without dedicated GPU like nvidia
    2. on entry level mobile phones and touch screen devices bought within 3 years

