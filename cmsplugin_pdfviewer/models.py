import os

from django.db import models
from django.conf import settings
from django.core.files.storage import default_storage
from django.utils.translation import ugettext_lazy as _

from cms.models import CMSPlugin
from cms.utils.compat.dj import python_2_unicode_compatible


@python_2_unicode_compatible
class PDFViewer(CMSPlugin):
    """
    Plugin for storing and displaying a PDF wrapped in a PDF.js instance.
    """
    pdf = models.FileField(_('pdf'), upload_to=CMSPlugin.get_media_path)
    title = models.CharField(_('title'), max_length=255, null=True, blank=True)

    def __str__(self):
        if self.title:
            return self.title
        elif self.pdf:
            return self.get_pdf_name()
        return _('<empty>')

    def file_exists(self):
        return default_storage.exists(self.pdf.name)

    def get_pdf_name(self):
        return os.path.basename(self.pdf.name)

    def get_ext(self):
        return os.path.splitext(self.get_pdf_name())[1][1:].lower()

    search_fields = ('title',)
