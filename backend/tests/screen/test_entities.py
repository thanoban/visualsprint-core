from app.screen.entities import EntityType, extract_entities


def test_extracts_ticket_id():
    entities = extract_entities("PAY-442 is blocking us, see JIRA-1234 too")
    ticket_ids = [e for e in entities if e.entity_type == EntityType.TICKET_ID]
    assert {e.text for e in ticket_ids} == {"PAY-442", "JIRA-1234"}
    first = ticket_ids[0]
    assert (first.start, first.end) == (0, 7)


def test_ticket_prefix_is_configurable():
    entities = extract_entities("FOO-99 should not match, ACME-1 should", ticket_prefixes=("ACME",))
    assert [e.text for e in entities if e.entity_type == EntityType.TICKET_ID] == ["ACME-1"]


def test_extracts_url():
    entities = extract_entities("see https://example.com/docs?x=1 for details")
    urls = [e for e in entities if e.entity_type == EntityType.URL]
    assert len(urls) == 1
    assert urls[0].text == "https://example.com/docs?x=1"


def test_extracts_python_stack_trace():
    text = (
        "Traceback (most recent call last):\n"
        '  File "app/main.py", line 10, in run\n'
        "    do_thing()\n"
        "ValueError: bad input\n"
    )
    entities = extract_entities(text)
    stack_lines = [e.text for e in entities if e.entity_type == EntityType.STACK_TRACE]
    assert any("Traceback" in line for line in stack_lines)
    assert any('File "app/main.py", line 10' in line for line in stack_lines)
    assert any("ValueError: bad input" in line for line in stack_lines)


def test_extracts_java_stack_trace():
    text = "Caused by: java.lang.NullPointerException\n\tat com.foo.Bar.method(Bar.java:42)\n"
    entities = extract_entities(text)
    stack_types = {e.entity_type for e in entities}
    assert EntityType.STACK_TRACE in stack_types
    matched = [e.text for e in entities if e.entity_type == EntityType.STACK_TRACE]
    assert any("at com.foo.Bar.method(Bar.java:42)" in line for line in matched)


def test_no_entities_in_plain_text():
    assert extract_entities("just a normal sentence about the roadmap") == []


def test_entities_are_sorted_by_position():
    entities = extract_entities("PAY-442 PAY-442 https://a.test")
    starts = [e.start for e in entities]
    assert starts == sorted(starts)
    assert len(entities) == 3  # two distinct ticket-id spans + one url


def test_identical_overlapping_matches_are_deduped():
    entities = extract_entities("PAY-442")
    assert len(entities) == 1
