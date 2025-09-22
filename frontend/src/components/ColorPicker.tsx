import React, { useState } from "react";
import {
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  ButtonBase,
  IconButton,
} from "@mui/material";
import {
  ColorLens as ColorLensIcon,
  Close as CloseIcon,
} from "@mui/icons-material";
import { Sketch } from "@uiw/react-color";

interface ColorPickerProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  label?: string;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  selectedColor,
  onColorChange,
  label = "Team Color",
}) => {
  const [open, setOpen] = useState(false);
  const [tempColor, setTempColor] = useState(selectedColor);

  const handleOpenDialog = () => {
    setTempColor(selectedColor);
    setOpen(true);
  };

  const handleClose = () => {
    setTempColor(selectedColor);
    setOpen(false);
  };

  const handleApply = () => {
    onColorChange(tempColor);
    setOpen(false);
  };

  const handleColorChange = (color: any) => {
    setTempColor(color.hex);
  };

  return (
    <>
      {/* Trigger Button */}
      <ButtonBase
        onClick={handleOpenDialog}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.75,
          borderRadius: 1,
          border: "2px solid transparent",
          "&:hover": {
            border: "2px solid #1976d2",
            bgcolor: "rgba(25,118,210,0.04)",
          },
          transition: "all 0.2s ease-in-out",
        }}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            bgcolor: selectedColor,
            border: "2px solid #fff",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "1px solid rgba(0,0,0,0.1)",
            },
          }}
        >
          <ColorLensIcon
            sx={{
              fontSize: 16,
              color: "#fff",
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))",
            }}
          />
        </Box>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            color: "#666",
            lineHeight: 1,
            flex: "0 1 auto",
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 160,
          }}
        >
          {label}
        </Typography>
      </ButtonBase>

      {/* Dialog */}
      <Dialog
        open={open}
        onClose={handleClose}
        maxWidth="xs"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
            overflow: "hidden",
          },
        }}
      >
        <DialogTitle
          sx={{ display: "flex", alignItems: "center", gap: 1, pr: 5 }}
        >
          <ColorLensIcon />
          <Typography variant="h6" sx={{ flex: 1 }}>
            Choose Color
          </Typography>
          <IconButton
            onClick={handleClose}
            aria-label="Close"
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent sx={{ pt: 1.5, pb: 2 }}>
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <Sketch
              color={tempColor}
              onChange={handleColorChange}
              style={{
                boxShadow: "none",
                width: "100%",
                maxWidth: "280px",
              }}
            />
          </Box>
        </DialogContent>

        <DialogActions sx={{ p: 1.5 }}>
          <Button onClick={handleClose} color="inherit">
            Cancel
          </Button>
          <Button onClick={handleApply} disableElevation>
            Apply
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
