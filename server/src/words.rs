use rand::seq::SliceRandom;

/// Short wordlist for human-friendly single-use invite codes. Lowercase, no
/// ambiguous spellings; four picks from this 100-word list give about 94M combinations.
const WORDS: &[&str] = &[
    "amber", "anchor", "apple", "aqua", "arrow", "aspen", "basil", "beacon", "berry", "birch",
    "bloom", "branch", "breeze", "brook", "cabin", "cedar", "cherry", "cloud", "clover", "coral",
    "cosmic", "cotton", "crisp", "daisy", "dawn", "delta", "dew", "drift", "ember", "fable",
    "falcon", "fern", "flint", "forest", "garnet", "ginger", "glade", "grove", "harbor", "hazel",
    "honey", "iris", "ivory", "jade", "jolly", "juniper", "kelp", "lagoon", "lark", "laurel",
    "lemon", "lilac", "lotus", "lunar", "maple", "marble", "meadow", "mint", "misty", "moss",
    "nectar", "noble", "ocean", "olive", "onyx", "opal", "orchid", "otter", "pearl", "pebble",
    "pine", "plum", "quartz", "quill", "rapid", "raven", "reed", "river", "robin", "rose",
    "sage", "sandy", "shell", "silver", "solar", "spruce", "storm", "summit", "sunny", "thistle",
    "tide", "topaz", "umber", "valley", "velvet", "willow", "winter", "wren", "zephyr", "zinnia",
];

/// Generate a single-use invite code: four random words joined by dashes.
pub fn generate_invite_code() -> String {
    let mut rng = rand::thread_rng();
    let picks: Vec<&str> = WORDS.choose_multiple(&mut rng, 4).copied().collect();
    picks.join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_four_dash_joined_words() {
        let code = generate_invite_code();
        let parts: Vec<&str> = code.split('-').collect();
        assert_eq!(parts.len(), 4);
        for p in parts {
            assert!(WORDS.contains(&p), "unexpected word {p}");
        }
    }

    #[test]
    fn codes_vary() {
        // Extremely unlikely to collide; guards against a fixed-seed mistake.
        let a = generate_invite_code();
        let b = generate_invite_code();
        assert_ne!(a, b);
    }
}
