use quarry_lib::commands::write_text;

#[test]
fn writes_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.csv");

    write_text(path.to_str().unwrap(), "id,name\n1,alice").unwrap();

    let read = std::fs::read_to_string(&path).unwrap();
    assert_eq!(read, "id,name\n1,alice");
}

#[test]
fn overwrites_an_existing_file() {
    // The Save panel already asked about replacing; refusing here would
    // contradict what the user was just told.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.csv");

    write_text(path.to_str().unwrap(), "first").unwrap();
    write_text(path.to_str().unwrap(), "second").unwrap();

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
}

#[test]
fn reports_an_unwritable_path_as_an_error() {
    // A directory that does not exist. The UI needs a real error here,
    // not a silent success that leaves the user believing they have a
    // file.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("no-such-dir").join("out.csv");

    assert!(write_text(path.to_str().unwrap(), "data").is_err());
}
