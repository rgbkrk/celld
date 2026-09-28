from bs4 import BeautifulSoup


def first_paragraph(html):
    soup = BeautifulSoup(html, "html.parser")
    paragraph = soup.select_one("p.x")
    return {"text": paragraph.get_text(), "bold": paragraph.b.get_text(), "count": len(soup.find_all("p"))}
